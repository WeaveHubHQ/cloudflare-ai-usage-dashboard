// Pure aggregation helpers shared by the collector (5m -> 1h -> 1d) and the read API.

export const FIVE_MIN = 300;
export const HOUR = 3600;
export const DAY = 86400;

/** Floor a unix-seconds timestamp to the start of its bucket (UTC). */
export const floorTo = (ts: number, width: number) => Math.floor(ts / width) * width;

export interface AiRow {
  ts: number;
  source: string;   // gateway | anthropic | openai | workers_ai
  app: string;
  gateway: string;  // gateway id, "direct" or "binding"
  provider: string;
  model: string;
  key: string;      // gateway id / api key name / script name
  requests: number;
  errors: number;
  tokens_in: number;
  tokens_out: number;
  tokens_cached: number;
  cost_usd: number;
  latency_ms: number; // sum over requests; divide by requests for the mean
}

export interface CfRow {
  ts: number;
  app: string;
  component: string; // key from config/prices.json cloudflare.components
  resource: string;
  units: number;
}

export const AI_KEYS = ['source', 'app', 'gateway', 'provider', 'model', 'key'] as const;
export const AI_SUMS = ['requests', 'errors', 'tokens_in', 'tokens_out', 'tokens_cached', 'cost_usd', 'latency_ms'] as const;
export const CF_KEYS = ['app', 'component', 'resource'] as const;

/**
 * Re-bucket rows to `width` seconds. Rows sharing a bucket and the same key
 * fields are combined: `sum` fields are added, and when `isGauge(row)` is true
 * (storage size, for example) the value is the max seen instead of a sum.
 */
export function rollup<T extends { ts: number }>(
  rows: readonly T[],
  width: number,
  keys: readonly (keyof T)[],
  sums: readonly (keyof T)[],
  isGauge: (row: T) => boolean = () => false,
): T[] {
  const out = new Map<string, T>();
  for (const r of rows) {
    const ts = floorTo(r.ts, width);
    const id = ts + '\u0000' + keys.map((k) => String(r[k])).join('\u0000');
    const cur = out.get(id);
    if (!cur) {
      out.set(id, { ...r, ts });
      continue;
    }
    const gauge = isGauge(r);
    const next = { ...cur };
    for (const s of sums) {
      const a = cur[s] as number, b = r[s] as number;
      (next[s] as number) = gauge ? Math.max(a, b) : a + b;
    }
    out.set(id, next);
  }
  return [...out.values()];
}

export const rollupAi = (rows: readonly AiRow[], width: number) => rollup(rows, width, AI_KEYS, AI_SUMS);

export const rollupCf = (rows: readonly CfRow[], width: number, gauges: ReadonlySet<string>) =>
  rollup(rows, width, CF_KEYS, ['units'], (r) => gauges.has(r.component));

/**
 * Collapse a time range to one value per key. Counters are summed; gauges
 * (storage) use their mean over the buckets present, which is how GB-month
 * billing averages storage.
 */
export function totalCf(rows: readonly CfRow[], gauges: ReadonlySet<string>): CfRow[] {
  const acc = new Map<string, { row: CfRow; n: number }>();
  for (const r of rows) {
    const id = r.app + '\u0000' + r.component + '\u0000' + r.resource;
    const cur = acc.get(id);
    if (!cur) acc.set(id, { row: { ...r, ts: 0 }, n: 1 });
    else acc.set(id, { row: { ...cur.row, units: cur.row.units + r.units }, n: cur.n + 1 });
  }
  return [...acc.values()].map(({ row, n }) => (gauges.has(row.component) ? { ...row, units: row.units / n } : row));
}
