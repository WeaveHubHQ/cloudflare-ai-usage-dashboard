// D1 persistence: idempotent upserts, 5m -> 1h -> 1d rollups, retention.
import { PRICES } from './config';
import type { ProviderCost } from './collectors/anthropic';
import { AI_KEYS, AI_SUMS, DAY, floorTo, HOUR, rollupAi, rollupCf, type AiRow, type CfRow } from './rollup';

export const GAUGES: ReadonlySet<string> = new Set(PRICES.cloudflare.components.filter((c) => c.storage).map((c) => c.key));

const AI_COLS = ['ts', ...AI_KEYS, ...AI_SUMS] as const;
const CF_COLS = ['ts', 'app', 'component', 'resource', 'units'] as const;
const PC_COLS = ['ts', 'provider', 'scope', 'description', 'cost_usd'] as const;

/**
 * Upsert that only writes when a value actually changed. Collectors re-read
 * overlapping windows every 5 minutes, and D1 bills every row written, so
 * rewriting unchanged rows would cost more than the data being collected.
 */
export function upsertSql(table: string, cols: readonly string[], pk: readonly string[]) {
  const vals = cols.filter((c) => !pk.includes(c));
  return `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})
    ON CONFLICT(${pk.join(',')}) DO UPDATE SET ${vals.map((c) => `${c}=excluded.${c}`).join(',')}
    WHERE ${vals.map((c) => `${table}.${c} IS NOT excluded.${c}`).join(' OR ')}`;
}

async function upsert<T>(db: D1Database, table: string, cols: readonly string[], pk: readonly string[], rows: readonly T[]) {
  const stmt = db.prepare(upsertSql(table, cols, pk));
  for (let i = 0; i < rows.length; i += 100) {
    await db.batch(rows.slice(i, i + 100).map((r) => stmt.bind(...cols.map((c) => (r as Record<string, unknown>)[c]))));
  }
}

export const tables = { ai: { '5m': 'ai_5m', '1h': 'ai_1h', '1d': 'ai_1d' }, cf: { '5m': 'cf_5m', '1h': 'cf_1h', '1d': 'cf_1d' } } as const;
export type Grain = '5m' | '1h' | '1d';

export const putAi = (db: D1Database, grain: Grain, rows: readonly AiRow[]) => upsert(db, tables.ai[grain], AI_COLS, ['ts', ...AI_KEYS], rows);
export const putCf = (db: D1Database, grain: Grain, rows: readonly CfRow[]) => upsert(db, tables.cf[grain], CF_COLS, ['ts', 'app', 'component', 'resource'], rows);
export const putProviderCost = (db: D1Database, rows: readonly ProviderCost[]) =>
  upsert(db, 'provider_cost_1d', PC_COLS, ['ts', 'provider', 'scope', 'description'], rows);

async function select<T>(db: D1Database, table: string, from: number, to: number): Promise<T[]> {
  const r = await db.prepare(`SELECT * FROM ${table} WHERE ts >= ? AND ts < ?`).bind(from, to).all<T>();
  return r.results;
}

/**
 * Recompute the coarser grains for every hour/day that [start, end) touches.
 * ponytail: hours are rebuilt from whatever finer rows exist, so an hour that
 * was backfilled at 1h grain and later partially collected at 5m is
 * overwritten by the partial 5m view. Only affects the first hour after setup.
 */
export async function rollUp(db: D1Database, from: Grain, start: number, end: number, { daily = true } = {}) {
  // Cloudflare usage is collected straight at hourly grain; only AI rows exist at 5 minutes.
  if (from === '5m') {
    const h0 = floorTo(start, HOUR), h1 = floorTo(end - 1, HOUR) + HOUR;
    await putAi(db, '1h', rollupAi(await select<AiRow>(db, 'ai_5m', h0, h1), HOUR));
  }
  const d0 = floorTo(start, DAY), d1 = floorTo(end - 1, DAY) + DAY;
  await putAi(db, '1d', rollupAi(await select<AiRow>(db, 'ai_1h', d0, d1), DAY));
  // The daily Cloudflare rollup touches every resource; once an hour is enough for the 30-day view.
  if (daily) await putCf(db, '1d', rollupCf(await select<CfRow>(db, 'cf_1h', d0, d1), DAY, GAUGES));
}

export async function prune(db: D1Database, now: number) {
  await db.batch([
    db.prepare('DELETE FROM ai_5m WHERE ts < ?').bind(now - 3 * DAY),
    db.prepare('DELETE FROM ai_1h WHERE ts < ?').bind(now - 40 * DAY),
    db.prepare('DELETE FROM cf_1h WHERE ts < ?').bind(now - 40 * DAY),
  ]);
}

export async function recordRun(db: D1Database, source: string, ok: boolean, rows: number, message = '') {
  await db.prepare('INSERT INTO collector_runs (source, ran_at, ok, rows, message) VALUES (?,?,?,?,?) ON CONFLICT(source) DO UPDATE SET ran_at=excluded.ran_at, ok=excluded.ok, rows=excluded.rows, message=excluded.message')
    .bind(source, Math.floor(Date.now() / 1000), ok ? 1 : 0, rows, message.slice(0, 500)).run();
}
