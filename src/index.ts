import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import { verifyAccess } from './access';
import { buildUsage, RANGES, type Range } from './api';
import { costsDue, runCollect, type Env } from './collect';
import { loadConfig, UNATTRIBUTED } from './config';
import { DAY, FIVE_MIN, floorTo, HOUR } from './rollup';
import { recordRun } from './store';

const app = new Hono<{ Bindings: Env }>();
// Local development only: `npm run dev` passes --var ENVIRONMENT:development, and
// the request must also be for localhost, so a stray variable can never open production.
const isDev = (env: Env, url: string) =>
  env.ENVIRONMENT === 'development' && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname);

// Security headers on every response, including 403/503 and static assets. A full CSP would
// need hashes for the inline theme script and styles; framing is what matters here.
app.use('*', secureHeaders({
  xFrameOptions: 'DENY',
  referrerPolicy: 'no-referrer',
  strictTransportSecurity: 'max-age=31536000; includeSubDomains',
  contentSecurityPolicy: { frameAncestors: ["'none'"] },
}));

// Every route, including static assets (run_worker_first), requires a valid
// Cloudflare Access JWT, so the dashboard fails closed until Access is set up.
app.use('*', async (c, next) => {
  if (isDev(c.env, c.req.url)) return next();
  if (!c.env.ACCESS_TEAM_DOMAIN || !c.env.ACCESS_AUD) {
    return c.text('Cloudflare Access is not configured yet. Run `npm run setup` or set ACCESS_TEAM_DOMAIN and ACCESS_AUD (see README).', 503);
  }
  const who = await verifyAccess(c.req.header('Cf-Access-Jwt-Assertion'), c.env.ACCESS_TEAM_DOMAIN, c.env.ACCESS_AUD);
  if (!who) return c.text('Forbidden', 403);
  await next();
});

app.get('/api/usage', async (c) => {
  const range = (c.req.query('range') ?? '24h') as Range;
  if (!(range in RANGES)) return c.json({ error: `range must be one of ${Object.keys(RANGES).join(', ')}` }, 400);
  const appId = c.req.query('app') || null;
  const known = new Set([...loadConfig(c.env.CONFIG_PROFILE).apps.map((a) => a.id), UNATTRIBUTED]);
  if (appId && !known.has(appId)) {
    return c.json({ error: 'unknown app' }, 400);
  }
  c.header('Cache-Control', 'private, max-age=60');
  return c.json(await buildUsage(c.env.DB, c.env.CONFIG_PROFILE, range, appId));
});

// Manual collection / backfill. Hourly grain for anything over 2 hours, pulled
// in 24h slices so no GraphQL dataset hits its 10,000-group limit. Capped at
// 7 days per call: each slice costs ~13 of the 300 GraphQL queries per 5 min.
app.post('/api/collect', async (c) => {
  // Not a form target: refuse cross-site browser requests (CSRF via the Access cookie).
  // Non-browser clients (curl) send no Sec-Fetch-Site header and are allowed.
  const site = c.req.header('Sec-Fetch-Site');
  if (site && site !== 'same-origin' && site !== 'none') return c.json({ error: 'cross-site request refused' }, 403);
  // Each call costs ~13 GraphQL queries per day collected (budget: 300 per 5 minutes).
  const last = await c.env.DB.prepare("SELECT ran_at FROM collector_runs WHERE source = 'cloudflare'").first<{ ran_at: number }>();
  if (last && Date.now() / 1000 - last.ran_at < 60) return c.json({ error: 'a collection ran less than a minute ago; try again shortly' }, 429);
  const hours = Math.min(Math.max(Number(c.req.query('hours') ?? 1) || 1, 1), 24 * 7);
  const now = Math.floor(Date.now() / 1000);
  const width = hours > 2 ? HOUR : FIVE_MIN;
  const end = floorTo(now, width) + width;
  const out: Record<string, string>[] = [];
  for (let s = end - hours * HOUR; s < end; s += 24 * HOUR) {
    out.push(await runCollect(c.env, { start: s, end: Math.min(s + 24 * HOUR, end), width }, { costs: out.length === 0 }));
  }
  return c.json(out.length === 1 ? out[0] : out);
});

// Re-wrap so the header middleware can modify the (otherwise immutable) asset response.
app.all('*', async (c) => { const r = await c.env.ASSETS.fetch(c.req.raw); return new Response(r.body, r); });

const BACKFILL_DAYS = 30;

/**
 * A fresh deployment has no history, and /api/collect sits behind Access. So
 * each cron run also collects one more day backwards (hourly grain) until 30
 * days are covered: about 2.5 hours after first deploy. The cursor lives in
 * collector_runs and only advances after a clean day, so failed days are retried.
 */
async function backfillStep(env: Env, now: number) {
  const row = await env.DB.prepare("SELECT message FROM collector_runs WHERE source = 'backfill'").first<{ message: string }>();
  const cursor = row ? Number(row.message) : floorTo(now, HOUR) - HOUR;
  if (!Number.isFinite(cursor) || cursor <= now - BACKFILL_DAYS * DAY) return;
  const start = cursor - DAY;
  const summary = await runCollect(env, { start, end: cursor, width: HOUR }, { costs: false });
  console.log('backfill', new Date(start * 1000).toISOString(), JSON.stringify(summary));
  // Only move on once the day collected cleanly; a failed day is retried on the next run.
  if (!Object.values(summary).some((v) => v.startsWith('error'))) await recordRun(env.DB, 'backfill', true, 0, String(start));
}

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    // Re-read from the start of the current hour (and the previous hour for the first 15 minutes,
    // so late analytics land). Unchanged rows are not rewritten, so the overlap costs reads only.
    const now = Math.floor(Date.now() / 1000);
    const end = floorTo(now, FIVE_MIN) + FIVE_MIN;
    const start = floorTo(now - 15 * 60, HOUR);
    const daily = new Date(now * 1000).getUTCMinutes() < 5;
    ctx.waitUntil((async () => {
      const costs = await costsDue(env.DB, now);
      console.log('collect', JSON.stringify(await runCollect(env, { start, end, width: FIVE_MIN }, { costs, daily })));
      await backfillStep(env, now);
    })());
  },
} satisfies ExportedHandler<Env>;
