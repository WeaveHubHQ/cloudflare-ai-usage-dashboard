// One collector run: every configured source independently, so one vendor
// outage never blocks the others. Each source's outcome is recorded for the UI.
import { collectAnthropic, collectAnthropicCost, type ProviderCost } from './collectors/anthropic';
import { collectCloudflare } from './collectors/cloudflare';
import { collectOpenAI, collectOpenAICost } from './collectors/openai';
import type { Window } from './collectors/util';
import { loadConfig } from './config';
import { DAY, floorTo, type AiRow, type CfRow } from './rollup';
import { prune, putAi, putCf, putProviderCost, recordRun, rollUp, type Grain } from './store';

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  CONFIG_PROFILE?: string;
  ENVIRONMENT?: string;
  CF_ACCOUNT_ID?: string;
  CF_API_TOKEN?: string;
  ANTHROPIC_ADMIN_KEY?: string;
  OPENAI_ADMIN_KEY?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
}

type Result = { ai?: AiRow[]; cf?: CfRow[]; cost?: ProviderCost[] };

/** Optional settings accept "none" (the Deploy to Cloudflare button may require a value for every secret). */
const opt = (v?: string) => (v && !/^(none|skip|-)?$/i.test(v.trim()) ? v.trim() : undefined);

/**
 * Daily provider cost reports change slowly and OpenAI's costs endpoint allows
 * 10 requests a minute, so they refresh at most hourly (sooner after a failure).
 */
export async function costsDue(db: D1Database, now: number) {
  const r = await db.prepare("SELECT MIN(ran_at) last FROM collector_runs WHERE source LIKE '%_cost' AND ok = 1").first<{ last: number | null }>();
  return !r?.last || now - r.last >= 55 * 60;
}

export async function runCollect(env: Env, w: Window, { costs = true, daily = true }: { costs?: boolean; daily?: boolean } = {}) {
  const cfg = loadConfig(env.CONFIG_PROFILE);
  const grain: Grain = w.width >= 3600 ? '1h' : '5m';
  // Provider cost reports are daily; re-read the last 3 days so late adjustments land.
  const d1 = floorTo(w.end, DAY) + DAY, d0 = Math.min(floorTo(w.start, DAY), d1 - 3 * DAY);

  const anthropicKey = opt(env.ANTHROPIC_ADMIN_KEY), openaiKey = opt(env.OPENAI_ADMIN_KEY);
  const sources: [string, (() => Promise<Result>) | null][] = ([
    ['cloudflare', env.CF_API_TOKEN && env.CF_ACCOUNT_ID
      ? () => collectCloudflare({ CF_ACCOUNT_ID: env.CF_ACCOUNT_ID!, CF_API_TOKEN: env.CF_API_TOKEN! }, cfg, w) : null],
    ['anthropic', anthropicKey ? async () => ({ ai: await collectAnthropic(anthropicKey, cfg, w) }) : null],
    ['anthropic_cost', anthropicKey ? async () => ({ cost: await collectAnthropicCost(anthropicKey, d0, d1) }) : null],
    ['openai', openaiKey ? async () => ({ ai: await collectOpenAI(openaiKey, cfg, w) }) : null],
    ['openai_cost', openaiKey ? async () => ({ cost: await collectOpenAICost(openaiKey, d0, d1) }) : null],
  ] as [string, (() => Promise<Result>) | null][]).filter(([name]) => costs || !name.endsWith('_cost'));

  const summary: Record<string, string> = {};
  await Promise.all(sources.map(async ([name, fn]) => {
    if (!fn) {
      summary[name] = 'not configured';
      return recordRun(env.DB, name, false, 0, 'not configured (secret missing or "none")');
    }
    try {
      const r = await fn();
      if (r.ai) await putAi(env.DB, grain, r.ai);
      if (r.cf) await putCf(env.DB, '1h', r.cf);
      if (r.cost) await putProviderCost(env.DB, r.cost);
      const n = (r.ai?.length ?? 0) + (r.cf?.length ?? 0) + (r.cost?.length ?? 0);
      summary[name] = `${n} rows`;
      await recordRun(env.DB, name, true, n);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`collector ${name} failed:`, msg);
      summary[name] = 'error: ' + msg;
      await recordRun(env.DB, name, false, 0, msg);
    }
  }));

  await rollUp(env.DB, grain, w.start, w.end, { daily });
  await prune(env.DB, w.end);
  return summary;
}
