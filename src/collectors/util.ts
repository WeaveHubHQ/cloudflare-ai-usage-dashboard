import { PRICES } from '../config';

export interface Window {
  /** Unix seconds, inclusive. */
  start: number;
  /** Unix seconds, exclusive. */
  end: number;
  /** Bucket width in seconds the collector should emit (300 or 3600). */
  width: number;
}

export const iso = (s: number) => new Date(s * 1000).toISOString().replace('.000Z', 'Z');
export const unix = (isoStr: string) => Math.floor(Date.parse(isoStr) / 1000);

/**
 * Strip anything credential-like from an upstream error body before it is thrown,
 * logged, stored in collector_runs and shown in the dashboard. Providers echo
 * partial keys in 401 messages (e.g. "Incorrect API key provided: sk-adm****abcd").
 */
export const redact = (t: string) =>
  t.replace(/\b(sk-[A-Za-z]{0,3})[\w*.-]*/g, '$1…').replace(/\bBearer\s+\S+/gi, 'Bearer …').replace(/\b(api[_-]?key["':= ]+)\S+/gi, '$1…');

/** fetch() JSON with a timeout; throws with the (redacted) response body on non-2xx so the run log says why. */
export async function getJson<T>(url: string, init: RequestInit = {}, timeoutMs = 25_000): Promise<T> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${new URL(url).pathname} -> ${res.status}: ${redact(text.slice(0, 300))}`);
  return JSON.parse(text) as T;
}

type ModelPrice = { in: number; out: number; cacheRead: number; cacheWrite: number };
const MODEL_KEYS = Object.keys(PRICES.models).sort((a, b) => b.length - a.length);

/** List price for a model id, matched by longest prefix ("claude-sonnet-4-5-20250929" -> "claude-sonnet-4-5"). */
export function modelPrice(model: string): ModelPrice | undefined {
  const k = MODEL_KEYS.find((p) => model.startsWith(p));
  return k ? (PRICES.models as Record<string, ModelPrice>)[k] : undefined;
}

/** Estimated USD for one usage row; 0 for unknown models (shown as an estimate in the UI). */
export function estimateCost(model: string, t: { uncached: number; out: number; cacheRead: number; cacheWrite: number }): number {
  const p = modelPrice(model);
  if (!p) return 0;
  return (t.uncached * p.in + t.out * p.out + t.cacheRead * p.cacheRead + t.cacheWrite * p.cacheWrite) / 1e6;
}
