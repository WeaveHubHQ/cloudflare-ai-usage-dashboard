// Anthropic Admin API: usage report (per key/workspace/model, 1-minute buckets)
// and the daily cost report. Endpoints and fields per
// platform.claude.com/docs/en/manage-claude/usage-cost-api (checked 2026-10-16).
import { attribute, matches, type DashboardConfig } from '../config';
import { floorTo, rollupAi, type AiRow } from '../rollup';
import { estimateCost, getJson, iso, unix, type Window } from './util';

const API = 'https://api.anthropic.com/v1/organizations';
const headers = (key: string) => ({ 'x-api-key': key, 'anthropic-version': '2023-06-01' });

interface UsageResult {
  uncached_input_tokens: number;
  cache_read_input_tokens: number;
  cache_creation?: { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number };
  output_tokens: number;
  api_key_id: string | null;
  workspace_id: string | null;
  model: string | null;
}
type Page<T> = { data: T[]; has_more: boolean; next_page?: string | null; last_id?: string };

async function keyNames(key: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  let after = '';
  for (let i = 0; i < 20; i++) {
    const r = await getJson<Page<{ id: string; name: string }>>(`${API}/api_keys?limit=1000${after}`, { headers: headers(key) });
    for (const k of r.data) out.set(k.id, k.name);
    if (!r.has_more || !r.last_id) break;
    after = `&after_id=${encodeURIComponent(r.last_id)}`;
  }
  return out;
}

async function* pages<T>(url: string, key: string) {
  let page = '';
  for (let i = 0; i < 50; i++) {
    const r = await getJson<Page<T>>(url + page, { headers: headers(key) });
    yield r.data;
    if (!r.has_more || !r.next_page) return;
    page = `&page=${encodeURIComponent(r.next_page)}`;
  }
}

export async function collectAnthropic(adminKey: string, cfg: DashboardConfig, w: Window): Promise<AiRow[]> {
  const names = await keyNames(adminKey);
  // 1-minute buckets keep the 5m view live; hourly backfills use 1h buckets (max 168 per page).
  const bw = w.width >= 3600 ? '1h' : '1m';
  const url = `${API}/usage_report/messages?starting_at=${iso(w.start)}&ending_at=${iso(w.end)}&bucket_width=${bw}&limit=${bw === '1h' ? 168 : 1440}`
    + '&group_by[]=api_key_id&group_by[]=workspace_id&group_by[]=model';
  const rows: AiRow[] = [];
  for await (const buckets of pages<{ starting_at: string; results: UsageResult[] }>(url, adminKey)) {
    for (const b of buckets) {
      for (const r of b.results) {
        const keyName = r.api_key_id ? names.get(r.api_key_id) ?? r.api_key_id : 'console';
        // Traffic routed through an AI Gateway is already counted from gateway analytics.
        if (matches(cfg.viaGateway?.anthropic_key, r.api_key_id, keyName)) continue;
        let app = attribute(cfg, 'anthropic_key', r.api_key_id, keyName);
        if (app === 'unattributed') app = attribute(cfg, 'anthropic_workspace', r.workspace_id ?? 'default');
        const model = r.model ?? 'unknown';
        const write5m = r.cache_creation?.ephemeral_5m_input_tokens ?? 0;
        const write1h = r.cache_creation?.ephemeral_1h_input_tokens ?? 0;
        rows.push({
          ts: floorTo(unix(b.starting_at), w.width), source: 'anthropic', app, gateway: 'direct', provider: 'anthropic', model, key: keyName,
          requests: 0, // the usage report has no request count
          errors: 0,
          tokens_in: r.uncached_input_tokens + r.cache_read_input_tokens + write5m + write1h,
          tokens_out: r.output_tokens,
          tokens_cached: r.cache_read_input_tokens,
          // 1h cache writes cost 2x base input vs 1.25x for 5m writes.
          cost_usd: estimateCost(model, { uncached: r.uncached_input_tokens, out: r.output_tokens, cacheRead: r.cache_read_input_tokens, cacheWrite: write5m + write1h * 1.6 }),
          latency_ms: 0,
        });
      }
    }
  }
  return rollupAi(rows, w.width);
}

export interface ProviderCost { ts: number; provider: string; scope: string; description: string; cost_usd: number }

/** Daily cost report (1d buckets only). `amount` is a decimal string in cents. */
export async function collectAnthropicCost(adminKey: string, startDay: number, endDay: number): Promise<ProviderCost[]> {
  const url = `${API}/cost_report?starting_at=${iso(startDay)}&ending_at=${iso(endDay)}&bucket_width=1d&limit=31&group_by[]=workspace_id&group_by[]=description`;
  const out = new Map<string, ProviderCost>();
  for await (const buckets of pages<{ starting_at: string; results: { amount: string; workspace_id: string | null; description: string | null; model?: string | null }[] }>(url, adminKey)) {
    for (const b of buckets) {
      for (const r of b.results) {
        const row = { ts: unix(b.starting_at), provider: 'anthropic', scope: r.workspace_id ?? 'default', description: r.model ?? r.description ?? 'other', cost_usd: Number(r.amount) / 100 };
        const id = `${row.ts}|${row.scope}|${row.description}`;
        const cur = out.get(id);
        out.set(id, cur ? { ...cur, cost_usd: cur.cost_usd + row.cost_usd } : row);
      }
    }
  }
  return [...out.values()];
}
