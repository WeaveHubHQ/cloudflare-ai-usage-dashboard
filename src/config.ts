// Config-driven attribution. All org-specific knowledge lives in config/*.json;
// nothing in src/ knows about any particular app or account.
import example from '../config/example.json';
import prices from '../config/prices.json';

/** Resource kinds that can be mapped to an app. */
export type MatchKind =
  | 'worker' | 'd1' | 'r2' | 'kv' | 'queue' | 'vectorize' | 'dispatch'
  | 'gateway' | 'workers_ai_model' | 'anthropic_key' | 'anthropic_workspace' | 'openai_project' | 'openai_key';

export interface AppDef {
  id: string;
  name: string;
  /** Shared infrastructure that should not be charged to a single product. */
  shared?: boolean;
  /** Patterns per resource kind. `*` matches any run of characters. */
  match: Partial<Record<MatchKind, string[]>>;
}

export interface DashboardConfig {
  title: string;
  /** Optional two-part wordmark, e.g. ["Weave", "Hub"]. */
  wordmark?: [string, string];
  theme: 'neutral' | 'navy-gold';
  apps: AppDef[];
  /** Provider keys whose traffic goes through an AI gateway (already counted from gateway data). */
  viaGateway?: { anthropic_key?: string[]; openai_key?: string[]; openai_project?: string[] };
  /** Gateways the collector reads. */
  gateways: string[];
  /** Footnotes rendered under the dashboard (exclusions, future integrations). */
  notes?: string[];
}

export const SHARED = 'shared';
export const UNATTRIBUTED = 'unattributed';

const PROFILES: Record<string, DashboardConfig> = {
  example: example as unknown as DashboardConfig,
};

export function loadConfig(profile = 'example'): DashboardConfig {
  const cfg = PROFILES[profile];
  if (!cfg) throw new Error(`Unknown CONFIG_PROFILE "${profile}" (have: ${Object.keys(PROFILES).join(', ')})`);
  return cfg;
}

export const PRICES = prices;

const globCache = new Map<string, RegExp>();
function glob(p: string): RegExp {
  let re = globCache.get(p);
  if (!re) {
    re = new RegExp('^' + p.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i');
    globCache.set(p, re);
  }
  return re;
}

export const matches = (patterns: string[] | undefined, ...names: (string | null | undefined)[]) =>
  !!patterns?.some((p) => names.some((n) => n != null && glob(p).test(n)));

/**
 * Map a resource to an app id. First matching app wins (config order), so put
 * specific apps before broad shared patterns. Any of `names` may match
 * (e.g. an API key's id or its display name).
 */
export function attribute(cfg: DashboardConfig, kind: MatchKind, ...names: (string | null | undefined)[]): string {
  for (const app of cfg.apps) if (matches(app.match[kind], ...names)) return app.id;
  return UNATTRIBUTED;
}

export function appNames(cfg: DashboardConfig): Record<string, string> {
  const out: Record<string, string> = { [UNATTRIBUTED]: 'Unattributed' };
  for (const a of cfg.apps) out[a.id] = a.name;
  return out;
}
