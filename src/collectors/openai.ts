// OpenAI organization Usage (completions) and Costs APIs. Endpoints and fields
// per the official openai-openapi spec (checked 2026-10-16).
import { attribute, matches, type DashboardConfig } from '../config';
import { floorTo, rollupAi, type AiRow } from '../rollup';
import type { ProviderCost } from './anthropic';
import { estimateCost, getJson, type Window } from './util';

const API = 'https://api.openai.com/v1/organization';
const headers = (key: string) => ({ Authorization: `Bearer ${key}` });
type Page<T> = { data: T[]; has_more: boolean; next_page?: string | null; last_id?: string };

interface UsageResult {
  input_tokens: number;           // includes cached and cache-write tokens
  input_uncached_tokens?: number;
  input_cached_tokens: number;
  input_cache_write_tokens?: number;
  output_tokens: number;
  num_model_requests: number;
  project_id: string | null;
  api_key_id: string | null;
  model: string | null;
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

async function projectNames(key: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  let after = '';
  for (let i = 0; i < 20; i++) {
    const r = await getJson<Page<{ id: string; name: string }>>(`${API}/projects?limit=100${after}`, { headers: headers(key) });
    for (const p of r.data) out.set(p.id, p.name);
    if (!r.has_more || !r.last_id) break;
    after = `&after=${encodeURIComponent(r.last_id)}`;
  }
  return out;
}

export async function collectOpenAI(adminKey: string, cfg: DashboardConfig, w: Window): Promise<AiRow[]> {
  const projects = await projectNames(adminKey);
  const bw = w.width >= 3600 ? '1h' : '1m';
  const url = `${API}/usage/completions?start_time=${w.start}&end_time=${w.end}&bucket_width=${bw}&limit=${bw === '1h' ? 168 : 1440}`
    + '&group_by=project_id&group_by=api_key_id&group_by=model';
  const rows: AiRow[] = [];
  for await (const buckets of pages<{ start_time: number; results: UsageResult[] }>(url, adminKey)) {
    for (const b of buckets) {
      for (const r of b.results) {
        const project = r.project_id ? projects.get(r.project_id) ?? r.project_id : 'default';
        const keyId = r.api_key_id ?? 'unknown';
        if (matches(cfg.viaGateway?.openai_key, keyId) || matches(cfg.viaGateway?.openai_project, r.project_id, project)) continue;
        let app = attribute(cfg, 'openai_key', keyId);
        if (app === 'unattributed') app = attribute(cfg, 'openai_project', r.project_id, project);
        const model = r.model ?? 'unknown';
        const write = r.input_cache_write_tokens ?? 0;
        const uncached = r.input_uncached_tokens ?? r.input_tokens - r.input_cached_tokens - write;
        rows.push({
          ts: floorTo(b.start_time, w.width), source: 'openai', app, gateway: 'direct', provider: 'openai', model, key: `${project}/${keyId}`,
          requests: r.num_model_requests, errors: 0,
          tokens_in: r.input_tokens, tokens_out: r.output_tokens, tokens_cached: r.input_cached_tokens,
          cost_usd: estimateCost(model, { uncached, out: r.output_tokens, cacheRead: r.input_cached_tokens, cacheWrite: write }),
          latency_ms: 0,
        });
      }
    }
  }
  return rollupAi(rows, w.width);
}

/** Daily costs (1d buckets only). `amount.value` is in dollars. */
export async function collectOpenAICost(adminKey: string, startDay: number, endDay: number): Promise<ProviderCost[]> {
  const url = `${API}/costs?start_time=${startDay}&end_time=${endDay}&bucket_width=1d&limit=180&group_by=project_id&group_by=line_item`;
  const out: ProviderCost[] = [];
  for await (const buckets of pages<{ start_time: number; results: { amount: { value: number }; project_id: string | null; line_item: string | null }[] }>(url, adminKey)) {
    for (const b of buckets) {
      for (const r of b.results) {
        out.push({ ts: b.start_time, provider: 'openai', scope: r.project_id ?? 'default', description: r.line_item ?? 'other', cost_usd: r.amount.value });
      }
    }
  }
  return out;
}
