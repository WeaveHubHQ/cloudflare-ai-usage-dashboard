// Model end-of-life callouts, driven by config/model-lifecycle.json.
import lifecycle from '../config/model-lifecycle.json';

export type Severity = 'retired' | 'urgent' | 'deprecated' | 'watch';
export interface Notice {
  model: string;
  severity: Severity;
  status: string;
  retires: string | null;
  daysLeft: number | null;
  replacement: string | null;
  note: string | null;
  source: string;
}

interface Entry { match: string; status: string; retires?: string; retiresNotBefore?: string; replacement?: string; note?: string; source: string }

const ENTRIES = (lifecycle.models as Entry[]).slice().sort((a, b) => b.match.length - a.match.length);
const SOURCES = lifecycle._sources as Record<string, string>;
/** Deprecated models retiring within this many days are flagged as urgent. */
export const URGENT_DAYS = 60;

export function lifecycleFor(model: string, now: number): Notice | null {
  const e = ENTRIES.find((x) => model.startsWith(x.match));
  if (!e || e.status === 'active') return null;
  const daysLeft = e.retires ? Math.ceil((Date.parse(e.retires + 'T00:00:00Z') / 1000 - now) / 86400) : null;
  const severity: Severity =
    e.status === 'retired' || (daysLeft !== null && daysLeft <= 0) ? 'retired'
      : e.status === 'deprecated' && daysLeft !== null && daysLeft <= URGENT_DAYS ? 'urgent'
        : e.status === 'deprecated' ? 'deprecated' : 'watch';
  return {
    model, severity, status: e.status, retires: e.retires ?? e.retiresNotBefore ?? null, daysLeft,
    replacement: e.replacement ?? null, note: e.note ?? null, source: SOURCES[e.source] ?? e.source,
  };
}
