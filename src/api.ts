// GET /api/usage: everything the dashboard renders for one range, aggregated server-side.
import { estimateBill, type Component } from './billing';
import { appNames, loadConfig, PRICES, SHARED, UNATTRIBUTED } from './config';
import { DAY, floorTo, HOUR, totalCf, type CfRow } from './rollup';
import { GAUGES } from './store';
import { lifecycleFor } from './lifecycle';

export const RANGES = {
  '24h': { days: 1, table: '1h', width: HOUR },
  '7d': { days: 7, table: '1h', width: HOUR },
  '30d': { days: 30, table: '1d', width: DAY },
} as const;
export type Range = keyof typeof RANGES;

const FLOW_SQL = (t: string) => `SELECT app, gateway, provider, model, source,
  SUM(requests) requests, SUM(errors) errors, SUM(tokens_in) tokens_in, SUM(tokens_out) tokens_out,
  SUM(tokens_cached) tokens_cached, SUM(cost_usd) cost_usd, SUM(latency_ms) latency_ms
  FROM ai_${t} WHERE ts >= ? AND ts < ? AND (?3 IS NULL OR app = ?3)
  GROUP BY app, gateway, provider, model, source`;

/** Last hour at 5-minute grain: drives the "live" particle flow, independent of the selected range. */
export const LIVE_WINDOW = 3600;
const LIVE_SQL = `SELECT app, gateway, provider, model, source, SUM(tokens_in + tokens_out) tokens, SUM(requests) requests
  FROM ai_5m WHERE ts >= ? AND (?2 IS NULL OR app = ?2) GROUP BY app, gateway, provider, model, source`;

const GAP_AI_SQL = (t: string) => `SELECT source, key, model, gateway, SUM(tokens_in + tokens_out) tokens
  FROM ai_${t} WHERE ts >= ? AND ts < ? AND app = 'unattributed' GROUP BY source, key, model, gateway ORDER BY tokens DESC LIMIT 50`;

/** Which config field matches a Cloudflare usage component. */
const FIELD_FOR: Record<string, string> = {
  wreq: 'worker (or dispatch)', wcpu: 'worker (or dispatch)', do: 'worker', dod: 'worker',
  d1r: 'd1', d1w: 'd1', d1s: 'd1', r2s: 'r2', r2a: 'r2', r2b: 'r2', kvr: 'kv', kvw: 'kv',
  q: 'queue', vecq: 'vectorize', vecs: 'vectorize', ai: 'workers_ai_model',
};

export interface Gap { field: string; name: string; detail: string; tokens?: number }

/** Unattributed AI keys and Cloudflare resources, with the config field that would claim each. */
function gaps(ai: { source: string; key: string; model: string; gateway: string; tokens: number }[], cf: CfRow[]): Gap[] {
  const out: Gap[] = [];
  for (const r of ai) {
    if (r.source === 'openai') {
      const [project, keyId] = r.key.includes('/') ? [r.key.slice(0, r.key.lastIndexOf('/')), r.key.slice(r.key.lastIndexOf('/') + 1)] : ['', r.key];
      out.push({ field: 'openai_key', name: keyId, detail: `OpenAI project "${project}" · ${r.model} (or match the project with openai_project)`, tokens: r.tokens });
    } else if (r.source === 'anthropic') out.push({ field: 'anthropic_key', name: r.key, detail: `Anthropic API key name · ${r.model}`, tokens: r.tokens });
    else if (r.source === 'gateway') out.push({ field: 'gateway', name: r.gateway, detail: `AI Gateway id · ${r.model}`, tokens: r.tokens });
    else out.push({ field: 'workers_ai_model', name: r.model, detail: 'Workers AI binding (attributed by model)', tokens: r.tokens });
  }
  const byRes = new Map<string, Set<string>>();
  for (const r of cf) if (r.app === 'unattributed') (byRes.get(r.resource) ?? byRes.set(r.resource, new Set()).get(r.resource)!).add(r.component);
  for (const [name, comps] of byRes) {
    const fields = [...new Set([...comps].map((c) => FIELD_FOR[c] ?? c))];
    const what = `Cloudflare ${[...comps].join(', ')}`;
    const isId = /^[0-9a-f]{8}-[0-9a-f]{4}-|^[0-9a-f]{32}$/.test(name);
    const detail = !name ? `${what}. Account-level operations (e.g. listing buckets); cannot be attributed`
      : name === '__unknown__' ? `${what}. Cloudflare could not name the Worker; cannot be attributed`
      : isId ? `${what}. Shown by id: a deleted resource, or the API token lacks read access to its name`
      : what;
    out.push({ field: fields.join(', '), name: name || '(account-level)', detail });
  }
  // Merge duplicate AI rows (same key across models), largest first.
  const merged = new Map<string, Gap>();
  for (const g of out) {
    const k = g.field + '|' + g.name, cur = merged.get(k);
    merged.set(k, cur ? { ...cur, tokens: (cur.tokens ?? 0) + (g.tokens ?? 0), detail: cur.detail } : g);
  }
  return [...merged.values()].sort((a, b) => (b.tokens ?? -1) - (a.tokens ?? -1));
}

const SERIES_SQL = (t: string) => `SELECT ts, app, SUM(cost_usd) cost, SUM(tokens_in + tokens_out) tokens, SUM(requests) requests
  FROM ai_${t} WHERE ts >= ? AND ts < ? AND (?3 IS NULL OR app = ?3) GROUP BY ts, app ORDER BY ts`;

const TOTAL_SQL = (t: string) => `SELECT SUM(cost_usd) cost, SUM(tokens_in + tokens_out) tokens, SUM(requests) requests
  FROM ai_${t} WHERE ts >= ? AND ts < ? AND (?3 IS NULL OR app = ?3)`;

export async function buildUsage(db: D1Database, profile: string | undefined, range: Range, app: string | null, now = Math.floor(Date.now() / 1000)) {
  const cfg = loadConfig(profile);
  const r = RANGES[range];
  const end = floorTo(now, r.width) + r.width; // include the current, partial bucket
  const start = end - r.days * DAY;
  const t = r.table;

  const [flows, series, prior, cfRows, cost, runs, live, gapAi] = await Promise.all([
    db.prepare(FLOW_SQL(t)).bind(start, end, app).all(),
    db.prepare(SERIES_SQL(t)).bind(start, end, app).all(),
    db.prepare(TOTAL_SQL(t)).bind(start - r.days * DAY, start, app).first(),
    db.prepare(`SELECT * FROM cf_${t} WHERE ts >= ? AND ts < ?`).bind(start, end).all<CfRow>(),
    db.prepare(`SELECT provider, scope, description, SUM(cost_usd) cost_usd FROM provider_cost_1d WHERE ts >= ? AND ts < ? GROUP BY 1,2,3`)
      .bind(floorTo(start, DAY), end).all(),
    db.prepare('SELECT * FROM collector_runs').all(),
    db.prepare(LIVE_SQL).bind(now - LIVE_WINDOW, app).all(),
    db.prepare(GAP_AI_SQL(t)).bind(start, end).all<{ source: string; key: string; model: string; gateway: string; tokens: number }>(),
  ]);

  // Cloudflare: totals per app and component, then the attributed bill estimate.
  const unitsByApp: Record<string, Record<string, number>> = {};
  const resources: Record<string, Record<string, number>> = {};
  for (const row of totalCf(cfRows.results, GAUGES)) {
    const u = (unitsByApp[row.app] ??= {});
    u[row.component] = (u[row.component] ?? 0) + row.units;
    const res = (resources[`${row.app}|${row.resource}`] ??= {});
    res[row.component] = row.units;
  }
  const components = PRICES.cloudflare.components as Component[];
  const baseMonthly = PRICES.cloudflare.baseFees.reduce((a, f) => a + f.monthly, 0);
  const bill = estimateBill(unitsByApp, components, baseMonthly, r.days);

  return {
    config: { title: cfg.title, wordmark: cfg.wordmark ?? null, theme: cfg.theme, notes: cfg.notes ?? [] },
    range, days: r.days, start, end, width: r.width, generatedAt: now, app,
    apps: appNames(cfg),
    shared: SHARED, unattributed: UNATTRIBUTED,
    flows: flows.results,
    live: live.results,
    lifecycle: [...new Set((flows.results as { model: string }[]).map((f) => f.model))]
      .map((m) => lifecycleFor(m, now)).filter((n) => n !== null),
    liveWindow: LIVE_WINDOW,
    gaps: gaps(gapAi.results, cfRows.results),
    series: series.results,
    prior,
    cloudflare: { components, unitsByApp, bill },
    providerCost: cost.results,
    runs: runs.results,
  };
}
