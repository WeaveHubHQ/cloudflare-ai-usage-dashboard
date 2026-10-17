#!/usr/bin/env node
// Fills the LOCAL D1 database with 30 days of synthetic usage for the apps in
// config/example.json, so the dashboard can be explored (and screenshotted)
// without any API tokens. Never touches a remote database.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const prices = JSON.parse(readFileSync('config/prices.json', 'utf8'));
const HOUR = 3600, DAY = 86400;
// Separate local state, so the demo never overwrites data collected by `npm run dev`.
const PERSIST = '.wrangler/demo';
const now = Math.floor(Date.now() / 1000);
const end = Math.floor(now / HOUR) * HOUR + HOUR;
const start = end - 30 * DAY;

let seed = 42;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
// Busier in the (UTC) afternoon, quieter on weekends, slowly growing.
const shape = (ts) => {
  const h = new Date(ts * 1000).getUTCHours(), dow = new Date(ts * 1000).getUTCDay();
  const diurnal = 0.45 + 0.55 * Math.max(0, Math.sin(((h - 6) / 24) * 2 * Math.PI));
  const weekend = dow === 0 || dow === 6 ? 0.6 : 1;
  const growth = 0.8 + 0.4 * ((ts - start) / (end - start));
  return diurnal * weekend * growth * (0.8 + 0.4 * rnd());
};

// [source, app, gateway, provider, model, key, tokens in/day, tokens out/day, cached share, requests/day, p50 ms, error rate]
const FLOWS = [
  ['gateway', 'storefront', 'storefront', 'anthropic', 'claude-haiku-4-5', 'storefront', 9e6, 1.1e6, 0.62, 21000, 900, 0.004],
  ['gateway', 'storefront', 'storefront', 'openai', 'gpt-5-mini', 'storefront', 4.2e6, 0.7e6, 0.3, 15000, 1400, 0.003],
  ['gateway', 'support', 'support', 'anthropic', 'claude-sonnet-4-5-20250929', 'support', 3.1e6, 0.45e6, 0.55, 2600, 3200, 0.006],
  ['anthropic', 'support', 'direct', 'anthropic', 'claude-opus-5', 'support-escalations', 0.6e6, 0.12e6, 0.2, 0, 0, 0],
  ['workers_ai', 'search', 'binding', 'workers-ai', '@cf/baai/bge-base-en-v1.5', 'binding', 5.5e6, 0, 0, 42000, 0, 0],
  ['openai', 'media', 'direct', 'openai', 'gpt-4o-mini-2024-07-18', 'Media/key_media_tagger', 1.8e6, 0.3e6, 0.1, 3100, 0, 0],
];
const modelPrice = (m) => prices.models[Object.keys(prices.models).sort((a, b) => b.length - a.length).find((k) => m.startsWith(k))];
const neuronPrice = prices.cloudflare.components.find((c) => c.key === 'ai').price;

// Cloudflare units per 30 days, per app and resource: [app, resource, component, units]
const CF = [
  ['storefront', 'storefront-api', 'wreq', 16e6], ['storefront', 'storefront-api', 'wcpu', 21e6],
  ['storefront', 'storefront-db', 'd1r', 9e9], ['storefront', 'storefront-db', 'd1w', 38e6], ['storefront', 'storefront-db', 'd1s', 3.2],
  ['storefront', 'storefront-cache', 'kvr', 7e6], ['storefront', 'storefront-cache', 'kvw', 0.4e6],
  ['storefront', 'storefront-assets', 'r2s', 14], ['storefront', 'storefront-assets', 'r2b', 6e6], ['storefront', 'storefront-assets', 'r2a', 0.2e6],
  ['support', 'support-api', 'wreq', 2.4e6], ['support', 'support-api', 'wcpu', 6e6], ['support', 'support-db', 'd1r', 2e9],
  ['support', 'support-db', 'd1w', 9e6], ['support', 'support-db', 'd1s', 1.1], ['support', 'support-tickets', 'q', 1.6e6],
  ['search', 'search-api', 'wreq', 3.1e6], ['search', 'search-api', 'wcpu', 9e6], ['search', 'search-index', 'vecq', 72e6], ['search', 'search-index', 'vecs', 46e6],
  ['search', '@cf/baai/bge-base-en-v1.5', 'ai', 520e3],
  ['media', 'media-worker', 'wreq', 0.9e6], ['media', 'media-worker', 'wcpu', 14e6], ['media', 'media-originals', 'r2s', 61],
  ['media', 'media-originals', 'r2a', 1.4e6], ['media', 'media-originals', 'r2b', 5.2e6], ['media', 'media-jobs', 'q', 0.9e6],
  ['shared', 'marketing-site', 'wreq', 4.6e6], ['shared', 'marketing-site', 'wcpu', 2.2e6], ['shared', 'auth-api', 'wreq', 1.9e6],
  ['shared', 'auth-db', 'd1r', 0.6e9], ['shared', 'auth-db', 'd1w', 2.1e6], ['shared', 'auth-db', 'd1s', 0.3], ['shared', 'sessions', 'kvr', 3.9e6],
  ['shared', 'auth-api', 'do', 0.7e6], ['shared', 'auth-api', 'dod', 160e3],
  ['unattributed', 'old-prototype', 'wreq', 0.3e6], ['unattributed', 'old-prototype', 'wcpu', 0.4e6], ['unattributed', 'scratch-bucket', 'r2s', 2.2],
];
const GAUGES = new Set(prices.cloudflare.components.filter((c) => c.storage).map((c) => c.key));

const ai = [], cf = [];
for (let ts = start; ts < end; ts += HOUR) {
  const k = shape(ts) / 24 / 0.55; // ~normalise the shape's mean back to per-day volumes
  for (const [source, app, gateway, provider, model, key, tin, tout, cached, req, p50, err] of FLOWS) {
    const tokens_in = Math.round(tin * k), tokens_out = Math.round(tout * k), tokens_cached = Math.round(tokens_in * cached);
    const requests = Math.round(req * k), p = modelPrice(model);
    const cost_usd = source === 'workers_ai'
      ? (tokens_in / 9) * neuronPrice
      : ((tokens_in - tokens_cached) * p.in + tokens_cached * p.cacheRead + tokens_out * p.out) / 1e6;
    ai.push({ ts, source, app, gateway, provider, model, key, requests, errors: Math.round(requests * err), tokens_in, tokens_out, tokens_cached, cost_usd, latency_ms: requests * p50 * (0.85 + 0.3 * rnd()) });
  }
  for (const [app, resource, component, monthly] of CF) {
    const units = GAUGES.has(component) ? monthly * (0.9 + 0.1 * ((ts - start) / (end - start))) : (monthly / 30) * k;
    cf.push({ ts, app, component, resource, units });
  }
}
const daily = (rows, keys, gaugeOf) => {
  const m = new Map();
  for (const r of rows) {
    const ts = Math.floor(r.ts / DAY) * DAY, id = [ts, ...keys.map((k) => r[k])].join('|');
    const cur = m.get(id);
    if (!cur) { m.set(id, { ...r, ts }); continue; }
    for (const [k, v] of Object.entries(r)) if (typeof v === 'number' && k !== 'ts') cur[k] = gaugeOf?.(r) ? Math.max(cur[k], v) : cur[k] + v;
  }
  return [...m.values()];
};
const val = (v) => (typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const insert = (table, rows) => {
  const cols = Object.keys(rows[0]);
  const out = [];
  for (let i = 0; i < rows.length; i += 200) {
    out.push(`INSERT INTO ${table} (${cols.join(',')}) VALUES ${rows.slice(i, i + 200).map((r) => `(${cols.map((c) => val(r[c])).join(',')})`).join(',')};`);
  }
  return out.join('\n');
};

const sql = [
  ...['ai_5m', 'ai_1h', 'ai_1d', 'cf_5m', 'cf_1h', 'cf_1d', 'provider_cost_1d', 'collector_runs'].map((t) => `DELETE FROM ${t};`),
  insert('ai_1h', ai), insert('ai_1d', daily(ai, ['source', 'app', 'gateway', 'provider', 'model', 'key'])),
  insert('cf_1h', cf), insert('cf_1d', daily(cf, ['app', 'component', 'resource'], (r) => GAUGES.has(r.component))),
  insert('provider_cost_1d', daily(ai.filter((r) => r.provider !== 'workers-ai'), ['provider']).map((r) => ({ ts: r.ts, provider: r.provider, scope: 'default', description: 'tokens', cost_usd: r.cost_usd }))),
  insert('collector_runs', ['cloudflare', 'anthropic', 'anthropic_cost', 'openai', 'openai_cost'].map((source) => ({ source, ran_at: now, ok: 1, rows: 0, message: 'demo data' }))),
].join('\n');

const dir = mkdtempSync(join(tmpdir(), 'usage-demo-'));
const file = join(dir, 'seed.sql');
writeFileSync(file, sql);
execFileSync('npx', ['wrangler', 'd1', 'migrations', 'apply', 'DB', '--local', '--persist-to', PERSIST], { stdio: 'inherit', env: { ...process.env, CI: 'true' } });
execFileSync('npx', ['wrangler', 'd1', 'execute', 'DB', '--local', '--persist-to', PERSIST, '--file', file], { stdio: 'inherit' });
console.log(`\nSeeded local D1 with ${ai.length} AI rows and ${cf.length} Cloudflare rows (30 days, config/example.json apps).`);
