#!/usr/bin/env node
// Interactive setup: creates the D1 database, runs migrations, attaches a custom
// domain, deploys, and stores every credential as a Worker secret after checking
// it against its API. Safe to re-run: existing resources and secrets are kept
// unless you enter a new value. No dependencies beyond Node 18+ and wrangler.
import { spawnSync } from 'node:child_process';
import { chmodSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const WRANGLER_CONFIG = 'wrangler.jsonc';
// --dry-run: log in, read and verify everything, but create, write, deploy and store nothing.
const DRY = process.argv.includes('--dry-run');
const DB_NAME = 'usage-dashboard';
const SECRETS = ['CF_ACCOUNT_ID', 'CF_API_TOKEN', 'ANTHROPIC_ADMIN_KEY', 'OPENAI_ADMIN_KEY', 'CONFIG_PROFILE', 'ACCESS_TEAM_DOMAIN', 'ACCESS_AUD'];

const c = { b: (s) => `\x1b[1m${s}\x1b[0m`, dim: (s) => `\x1b[2m${s}\x1b[0m`, ok: (s) => `\x1b[32m${s}\x1b[0m`, warn: (s) => `\x1b[33m${s}\x1b[0m`, err: (s) => `\x1b[31m${s}\x1b[0m` };
const step = (n, title) => console.log(`\n${c.b(`[${n}/8] ${title}`)}`);
const ok = (s) => console.log(`  ${c.ok('✓')} ${s}`);
const warn = (s) => console.log(`  ${c.warn('!')} ${s}`);
const die = (s) => { console.error(`\n${c.err('✗')} ${s}`); process.exit(1); };

// ---------- prompts ----------
const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
let muted = false;
rl._writeToOutput = (s) => { if (!muted || s.includes('\n')) process.stdout.write(muted ? '\n' : s); };
const ask = (q, def = '') => new Promise((r) => rl.question(`  ${q}${def ? c.dim(` [${def}]`) : ''}: `, (a) => r(a.trim() || def)));
const askSecret = (q) => new Promise((r) => { rl.question(`  ${q}: `, (a) => { muted = false; r(a.trim()); }); muted = true; });
const yes = async (q, def = 'y') => /^y/i.test(await ask(`${q} (y/n)`, def));

// ---------- wrangler ----------
let accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? '';
const env = () => ({ ...process.env, ...(accountId ? { CLOUDFLARE_ACCOUNT_ID: accountId } : {}) });
const wrangler = (args, opts = {}) => {
  // Hand the terminal to wrangler in normal (cooked) mode so its own prompts work.
  const raw = process.stdin.isTTY && process.stdin.isRaw;
  if (opts.inherit && raw) process.stdin.setRawMode(false);
  const r = spawnSync('npx', ['wrangler', ...args], { env: env(), encoding: 'utf8', stdio: opts.inherit ? 'inherit' : ['pipe', 'pipe', 'pipe'], input: opts.input });
  if (opts.inherit && raw) process.stdin.setRawMode(true);
  if (opts.must && r.status !== 0) die(`wrangler ${args.join(' ')} failed:\n${r.stderr || r.stdout || ''}`);
  return r;
};

// ---------- API checks (read-only GETs) ----------
async function http(url, headers, init = {}) {
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(20000), ...init });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  } catch (e) { return { status: 0, body: { error: String(e) } }; }
}

async function checkCloudflare(token) {
  const h = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const now = new Date(), since = new Date(now - 3600e3);
  const q = `query($a: string!) { viewer { accounts(filter: { accountTag: $a }) {
    workersInvocationsAdaptive(limit: 1, filter: { datetime_geq: "${since.toISOString()}", datetime_lt: "${now.toISOString()}" }) { sum { requests } } } } }`;
  const g = await http('https://api.cloudflare.com/client/v4/graphql', h, { method: 'POST', body: JSON.stringify({ query: q, variables: { a: accountId } }) });
  // The analytics API allows 300 queries per 5 minutes per user; a depleted budget says nothing about permissions.
  if (g.body.errors?.some((e) => e.extensions?.code === 'budget')) {
    return ['WARN GraphQL rate limit reached, so analytics access could not be checked right now. The collector retries every 5 minutes.'];
  }
  if (g.status !== 200 || g.body.errors?.length || !g.body.data?.viewer?.accounts?.length) {
    return [`GraphQL analytics failed (${g.status}): ${JSON.stringify(g.body.errors ?? g.body).slice(0, 200)}. Needs "Account Analytics: Read" on this account.`];
  }
  const problems = [];
  for (const [path, perm] of [['d1/database', 'D1: Read'], ['storage/kv/namespaces', 'Workers KV Storage: Read'], ['queues', 'Queues: Read'], ['workers/durable_objects/namespaces', 'Workers Scripts: Read']]) {
    const r = await http(`https://api.cloudflare.com/client/v4/accounts/${accountId}/${path}?per_page=1`, h);
    if (r.status !== 200) problems.push(`optional "${perm}" missing (${r.status}): those resources will show by id instead of name`);
  }
  return problems.map((p) => 'WARN ' + p);
}
async function checkAnthropic(key) {
  const r = await http('https://api.anthropic.com/v1/organizations/api_keys?limit=1', { 'x-api-key': key, 'anthropic-version': '2023-06-01' });
  if (r.status === 200) return [];
  const hint = r.status === 403 || r.status === 401
    ? ' The Admin API needs an Admin key (sk-ant-admin01-…, not sk-ant-api03-…) from a Console *organization*; individual accounts cannot use it. Set one up at platform.claude.com/settings/organization, or press Enter to skip Anthropic for now.'
    : ' Use an Admin key (sk-ant-admin01-…).';
  return [`Anthropic Admin API returned ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}.${hint}`];
}
async function checkOpenAI(key) {
  const start = Math.floor(Date.now() / 1000) - 86400;
  const r = await http(`https://api.openai.com/v1/organization/usage/completions?start_time=${start}&limit=1`, { Authorization: `Bearer ${key}` });
  if (r.status !== 200) return [`OpenAI Usage API returned ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}. Use an Admin key with usage read.`];
  const p = await http('https://api.openai.com/v1/organization/projects?limit=1', { Authorization: `Bearer ${key}` });
  return p.status === 200 ? [] : ['WARN optional project read missing: projects will show by id instead of name'];
}
const teamDomain = (v) => `${v.trim().replace(/^https?:\/\//, '').replace(/\.cloudflareaccess\.com\/?$/, '')}.cloudflareaccess.com`;
async function checkAccessTeam(domain) {
  const r = await http(`https://${domain}/cdn-cgi/access/certs`, {});
  return r.status === 200 && r.body.keys?.length ? [] : [`https://${domain}/cdn-cgi/access/certs returned ${r.status}. Check the team name.`];
}

/** Ask for a secret, validate it, and loop until it passes or the user keeps the existing value. */
async function secretValue(name, label, { existing, optional, check, hidden = true }) {
  for (;;) {
    const hint = existing ? 'Enter to keep the current value' : optional ? 'Enter to skip' : '';
    const v = hidden ? await askSecret(`${label}${hint ? c.dim(` (${hint})`) : ''}`) : await ask(`${label}${hint ? c.dim(` (${hint})`) : ''}`);
    if (!v) {
      if (existing) { ok(`${name}: kept`); return null; }
      if (optional) { ok(`${name}: skipped`); return 'none'; }
      warn('A value is required.'); continue;
    }
    const problems = check ? await check(v) : [];
    const hard = problems.filter((p) => !p.startsWith('WARN '));
    problems.filter((p) => p.startsWith('WARN ')).forEach((p) => warn(p.slice(5)));
    if (!hard.length) { ok(`${name}: verified`); return v; }
    hard.forEach((p) => console.log(`  ${c.err('✗')} ${p}`));
    if (!(await yes('Try again?'))) die('Setup stopped. Nothing secret was stored.');
  }
}

// ---------- config file edits ----------
const readCfg = () => readFileSync(WRANGLER_CONFIG, 'utf8');
function setDatabaseId(id) {
  if (DRY) return;
  writeFileSync(WRANGLER_CONFIG, readCfg().replace(/("database_id":\s*")[^"]*(")/, `$1${id}$2`));
}
function setCustomDomain(host) {
  if (DRY) return;
  const s = readCfg();
  const route = `"routes": [{ "pattern": ${JSON.stringify(host)}, "custom_domain": true }],`;
  writeFileSync(WRANGLER_CONFIG, /^\s*"routes":.*$/m.test(s)
    ? s.replace(/^(\s*)"routes":.*$/m, `$1${route}`)
    : s.replace(/^(\s*)\/\/ "routes":.*$/m, `$1${route}`));
}

// ---------- main ----------
console.log(`\n${c.b('Usage dashboard setup')}${DRY ? c.warn(' (dry run: nothing is created or stored)') : ''}\n${c.dim('Creates or reuses: D1 database, Worker, custom domain, Worker secrets. Re-run any time.')}`);

step(1, 'Cloudflare login');
let who = wrangler(['whoami']);
if (/not authenticated|not logged in/i.test(who.stdout + who.stderr)) {
  console.log('  Opening the browser to log in to Cloudflare...');
  wrangler(['login'], { inherit: true, must: true });
  who = wrangler(['whoami']);
}
const accounts = [...(who.stdout + who.stderr).matchAll(/│\s*(.+?)\s*│\s*([0-9a-f]{32})\s*│/g)].map((m) => ({ name: m[1], id: m[2] }));
if (!accountId) {
  accounts.forEach((a, i) => console.log(`    ${i + 1}. ${a.name} ${c.dim(a.id)}`));
  const pick = await ask(accounts.length ? 'Account number or ID' : 'Account ID', accounts.length === 1 ? '1' : '');
  accountId = accounts[Number(pick) - 1]?.id ?? pick;
}
if (!/^[0-9a-f]{32}$/.test(accountId)) die(`"${accountId}" is not a Cloudflare account ID (32 hex characters).`);
ok(`Account ${accountId}`);

step(2, 'Attribution profile');
const profiles = readdirSync('config').filter((f) => f.endsWith('.json') && f !== 'prices.json').map((f) => f.replace(/\.json$/, ''));
console.log(`  ${c.dim('config/<profile>.json maps your Workers, databases, buckets, gateways and API keys to apps.')}`);
const profile = await ask(`Profile (${profiles.join(', ')})`, profiles.includes('example') ? 'example' : profiles[0]);
if (!profiles.includes(profile)) die(`No config/${profile}.json`);
ok(`Using config/${profile}.json`);

step(3, 'D1 database');
const listDbs = () => JSON.parse(wrangler(['d1', 'list', '--json'], { must: true }).stdout || '[]');
let db = listDbs().find((d) => d.name === DB_NAME);
if (db) ok(`Reusing ${DB_NAME} (${db.uuid})`);
else if (DRY) { db = { uuid: '(would be created)' }; ok(`Would create ${DB_NAME}`); }
else {
  wrangler(['d1', 'create', DB_NAME], { must: true });
  db = listDbs().find((d) => d.name === DB_NAME) ?? die('Database was created but not found in the list.');
  ok(`Created ${DB_NAME} (${db.uuid})`);
}
setDatabaseId(db.uuid);
ok(`${DRY ? 'Would write' : 'Wrote'} database_id to ${WRANGLER_CONFIG}`);
if (!DRY) { wrangler(['d1', 'migrations', 'apply', 'DB', '--remote'], { inherit: true, must: true }); ok('Migrations applied'); }

step(4, 'Custom domain');
console.log(`  ${c.dim('The dashboard has no workers.dev URL. It is served on a hostname in a zone on this account, e.g. usage.example.com.')}`);
const current = readCfg().match(/^\s*"routes":\s*\[\{\s*"pattern":\s*"([^"]+)"/m)?.[1] ?? '';
const host = await ask('Hostname', current);
if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host)) die(`"${host}" is not a hostname.`);
setCustomDomain(host);
ok(`${host} → Worker (custom domain, DNS and certificate are created on deploy)`);

step(5, 'Credentials');
const secretList = wrangler(['secret', 'list', '--format', 'json']);
const existing = new Set(secretList.status === 0 ? JSON.parse(secretList.stdout || '[]').map((s) => s.name) : []);
console.log(`  ${c.dim('Values are checked with read-only GET requests, then stored only as encrypted Worker secrets.')}`);
console.log(`  ${c.dim('Cloudflare token: Account Analytics: Read (required); D1, Workers KV Storage, Queues, Workers Scripts: Read (names).')}`);
const values = { CF_ACCOUNT_ID: accountId, CONFIG_PROFILE: profile };
values.CF_API_TOKEN = await secretValue('CF_API_TOKEN', 'Cloudflare read-only API token', { existing: existing.has('CF_API_TOKEN'), check: checkCloudflare });
values.ANTHROPIC_ADMIN_KEY = await secretValue('ANTHROPIC_ADMIN_KEY', 'Anthropic Admin key (sk-ant-admin01-…)', { existing: existing.has('ANTHROPIC_ADMIN_KEY'), optional: true, check: checkAnthropic });
values.OPENAI_ADMIN_KEY = await secretValue('OPENAI_ADMIN_KEY', 'OpenAI Admin key (usage read)', { existing: existing.has('OPENAI_ADMIN_KEY'), optional: true, check: checkOpenAI });

step(6, 'Cloudflare Access');
console.log(`  ${c.dim('Create a self-hosted Access application for')} ${c.b(host)} ${c.dim('first (Zero Trust → Access → Applications → Add → Self-hosted),')}`);
console.log(`  ${c.dim('add an Allow policy for your team, then copy the Application Audience (AUD) tag from its Overview tab.')}`);
values.ACCESS_TEAM_DOMAIN = await secretValue('ACCESS_TEAM_DOMAIN', 'Zero Trust team name (the part before .cloudflareaccess.com)', {
  existing: existing.has('ACCESS_TEAM_DOMAIN'), hidden: false,
  check: async (v) => checkAccessTeam(teamDomain(v)),
});
if (values.ACCESS_TEAM_DOMAIN) values.ACCESS_TEAM_DOMAIN = teamDomain(values.ACCESS_TEAM_DOMAIN);
values.ACCESS_AUD = await secretValue('ACCESS_AUD', 'Application Audience (AUD) tag', {
  existing: existing.has('ACCESS_AUD'), hidden: false,
  check: async (v) => (/^[0-9a-f]{64}$/.test(v) ? [] : ['An AUD tag is 64 hex characters.']),
});

step(7, 'Deploy');
if (DRY) ok('Would run wrangler deploy');
else { wrangler(['deploy'], { inherit: true, must: true }); ok('Worker deployed'); }

step(8, 'Store secrets');
for (const name of SECRETS) {
  const v = values[name];
  if (v == null) continue;
  if (DRY) { ok(`Would store ${name}`); continue; }
  wrangler(['secret', 'put', name], { input: v, must: true });
  ok(`${name} stored`);
}

if (!DRY && await yes('Also write .dev.vars for local `npm run dev`?', 'n')) {
  const lines = Object.entries(values).filter(([k, v]) => v != null && !k.startsWith('ACCESS_')).map(([k, v]) => `${k}=${v}`);
  writeFileSync('.dev.vars', lines.join('\n') + '\n', { mode: 0o600 });
  chmodSync('.dev.vars', 0o600); // mode only applies when the file is created
  ok('.dev.vars written (git-ignored, mode 600)');
}
rl.close();

console.log(`
${c.ok(c.b('Done.'))} Open ${c.b(`https://${host}`)} and sign in through Access.
  • The collector runs every 5 minutes; the first data appears within 5 minutes.
  • It also backfills one day of history per run, so 30 days are filled in about 2.5 hours.
  • ${WRANGLER_CONFIG} now holds your database id and domain. Commit it to your fork so redeploys keep them.
  • The status badge in the header shows the last run of each source; hover it for details.`);
