// Cloudflare platform usage via the GraphQL Analytics API, plus AI Gateway and
// Workers AI traffic. Field names checked against live schema introspection
// (2026-10-16). Each dataset node in a request counts toward the 300
// queries / 5 min GraphQL budget, so everything goes in one request per run.
import { attribute, PRICES, type DashboardConfig } from '../config';
import type { AiRow, CfRow } from '../rollup';
import { floorTo, HOUR } from '../rollup';
import { getJson, iso, unix, type Window } from './util';

export interface CfEnv {
  CF_ACCOUNT_ID: string;
  CF_API_TOKEN: string;
}

const API = 'https://api.cloudflare.com/client/v4';
const GB = 1024 ** 3;
const CLASS_A = new Set(PRICES.cloudflare.r2ClassA);
const CLASS_B = new Set(PRICES.cloudflare.r2ClassB);
// Durable Objects bill duration at 128 MB regardless of memory used.
const DO_GB = 0.125;

const auth = (env: CfEnv) => ({ Authorization: `Bearer ${env.CF_API_TOKEN}` });

/** id -> display name for resources the analytics API reports by id. */
async function listAll(env: CfEnv, path: string, id: string, name: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let page = 1; page < 50; page++) {
    const sep = path.includes('?') ? '&' : '?';
    const r = await getJson<{ result: Record<string, string>[]; result_info?: { total_pages?: number } }>(
      `${API}/accounts/${env.CF_ACCOUNT_ID}/${path}${sep}page=${page}&per_page=100`, { headers: auth(env) });
    for (const x of r.result ?? []) out.set(x[id], x[name]);
    if (!r.result_info?.total_pages || page >= r.result_info.total_pages) break;
  }
  return out;
}

/** Name lookups are best effort: without the permission, resources show (and attribute) by id. */
const tryList = (env: CfEnv, path: string, id: string, name: string) =>
  listAll(env, path, id, name).catch((e) => {
    console.warn(`name lookup ${path} failed, using ids:`, e instanceof Error ? e.message : e);
    return new Map<string, string>();
  });

async function resolveNames(env: CfEnv) {
  const [d1, kv, queues, dos] = await Promise.all([
    tryList(env, 'd1/database', 'uuid', 'name'),
    tryList(env, 'storage/kv/namespaces', 'id', 'title'),
    tryList(env, 'queues', 'queue_id', 'queue_name'),
    tryList(env, 'workers/durable_objects/namespaces', 'id', 'script'),
  ]);
  return { d1, kv, queues, dos };
}

async function graphql<T>(env: CfEnv, query: string, variables: Record<string, unknown>): Promise<T> {
  const r = await getJson<{ data: T; errors?: { message: string; path?: string[] }[] }>(`${API}/graphql`, {
    method: 'POST',
    headers: { ...auth(env), 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (r.errors?.length) throw new Error('GraphQL: ' + r.errors.map((e) => `${e.path?.join('.') ?? ''} ${e.message}`).join('; '));
  return r.data;
}

type G<D, S = Record<string, number>> = { dimensions: D; sum?: S; max?: S; count?: number; quantiles?: S }[];

/**
 * Build the one GraphQL request. Platform datasets are always hourly (the dashboard stores Cloudflare
 * usage at hourly grain); `t` is the AI datasets' dimension (datetimeFiveMinutes or datetimeHour).
 * Each dataset has its own filter input type, so the time filter is inlined rather than passed as a variable.
 * Storage and Vectorize datasets have no five-minute dimension and are always hourly.
 */
export function buildQuery(t: string, w: Window, gateways: string[]) {
  const time = `datetime_geq: ${JSON.stringify(iso(w.start))}, datetime_lt: ${JSON.stringify(iso(w.end))}`;
  const $f = `{ ${time} }`;
  return `query Usage($acct: string!) {
  viewer { accounts(filter: { accountTag: $acct }) {
    workers: workersInvocationsAdaptive(limit: 10000, filter: ${$f}) {
      dimensions { ts: datetimeHour scriptName dispatchNamespaceName } sum { requests errors cpuTimeUs } }
    d1: d1AnalyticsAdaptiveGroups(limit: 10000, filter: ${$f}) {
      dimensions { ts: datetimeHour databaseId } sum { rowsRead rowsWritten } }
    d1s: d1StorageAdaptiveGroups(limit: 10000, filter: ${$f}) {
      dimensions { ts: datetimeHour databaseId } max { databaseSizeBytes } }
    r2: r2OperationsAdaptiveGroups(limit: 10000, filter: ${$f}) {
      dimensions { ts: datetimeHour bucketName actionType } sum { requests } }
    r2s: r2StorageAdaptiveGroups(limit: 10000, filter: ${$f}) {
      dimensions { ts: datetimeHour bucketName } max { payloadSize metadataSize } }
    kv: kvOperationsAdaptiveGroups(limit: 10000, filter: ${$f}) {
      dimensions { ts: datetimeHour namespaceId actionType } sum { requests } }
    queues: queueMessageOperationsAdaptiveGroups(limit: 10000, filter: ${$f}) {
      dimensions { ts: datetimeHour queueId } sum { billableOperations } }
    doreq: durableObjectsInvocationsAdaptiveGroups(limit: 10000, filter: ${$f}) {
      dimensions { ts: datetimeHour scriptName } sum { requests } }
    dodur: durableObjectsPeriodicGroups(limit: 10000, filter: ${$f}) {
      dimensions { ts: datetimeHour namespaceId } sum { activeTime } }
    vecq: vectorizeV2QueriesAdaptiveGroups(limit: 10000, filter: ${$f}) {
      dimensions { ts: datetimeHour indexName } sum { queriedVectorDimensions } }
    vecs: vectorizeV2StorageAdaptiveGroups(limit: 10000, filter: ${$f}) {
      dimensions { ts: datetimeHour indexName } max { storedVectorDimensions } }
    ai: aiInferenceAdaptiveGroups(limit: 10000, filter: ${$f}) {
      count dimensions { ts: ${t} modelId requestSource } sum { totalNeurons totalInputTokens totalOutputTokens } }
    gw: aiGatewayRequestsAdaptiveGroups(limit: 10000, filter: { ${time}, gateway_in: ${JSON.stringify(gateways)} }) {
      count dimensions { ts: ${t} gateway provider model }
      sum { tokensIn tokensOut cacheReadTokens cost erroredRequests }
      quantiles { durationMsP50 } }
  } }
}`;
}

interface UsageData {
  viewer: { accounts: {
    workers: G<{ ts: string; scriptName: string; dispatchNamespaceName: string }>;
    d1: G<{ ts: string; databaseId: string }>;
    d1s: G<{ ts: string; databaseId: string }>;
    r2: G<{ ts: string; bucketName: string; actionType: string }>;
    r2s: G<{ ts: string; bucketName: string }>;
    kv: G<{ ts: string; namespaceId: string; actionType: string }>;
    queues: G<{ ts: string; queueId: string }>;
    doreq: G<{ ts: string; scriptName: string }>;
    dodur: G<{ ts: string; namespaceId: string }>;
    vecq: G<{ ts: string; indexName: string }>;
    vecs: G<{ ts: string; indexName: string }>;
    ai: G<{ ts: string; modelId: string; requestSource: string }>;
    gw: G<{ ts: string; gateway: string; provider: string; model: string }>;
  }[] };
}

export async function collectCloudflare(env: CfEnv, cfg: DashboardConfig, w: Window): Promise<{ cf: CfRow[]; ai: AiRow[] }> {
  const t = w.width >= 3600 ? 'datetimeHour' : 'datetimeFiveMinutes';
  const [names, data] = await Promise.all([
    resolveNames(env),
    graphql<UsageData>(env, buildQuery(t, w, cfg.gateways), { acct: env.CF_ACCOUNT_ID }),
  ]);
  const a = data.viewer.accounts[0];
  if (!a) throw new Error('GraphQL returned no account; check CF_ACCOUNT_ID and the token’s Account Analytics: Read permission');

  const cf: CfRow[] = [];
  const add = (ts: string, kind: Parameters<typeof attribute>[1], resource: string, component: string, units: number) => {
    if (units) cf.push({ ts: floorTo(unix(ts), HOUR), app: attribute(cfg, kind, resource), component, resource, units });
  };

  for (const r of a.workers) {
    // Workers for Platforms user workers are attributed by their dispatch namespace.
    const ns = r.dimensions.dispatchNamespaceName;
    const kind = ns ? 'dispatch' : 'worker';
    const res = ns || r.dimensions.scriptName;
    add(r.dimensions.ts, kind, res, 'wreq', r.sum!.requests);
    add(r.dimensions.ts, kind, res, 'wcpu', r.sum!.cpuTimeUs / 1000);
  }
  for (const r of a.d1) {
    const n = names.d1.get(r.dimensions.databaseId) ?? r.dimensions.databaseId;
    add(r.dimensions.ts, 'd1', n, 'd1r', r.sum!.rowsRead);
    add(r.dimensions.ts, 'd1', n, 'd1w', r.sum!.rowsWritten);
  }
  for (const r of a.d1s) add(r.dimensions.ts, 'd1', names.d1.get(r.dimensions.databaseId) ?? r.dimensions.databaseId, 'd1s', r.max!.databaseSizeBytes / GB);
  for (const r of a.r2) {
    const c = CLASS_A.has(r.dimensions.actionType) ? 'r2a' : CLASS_B.has(r.dimensions.actionType) ? 'r2b' : null; // deletes are free
    if (c) add(r.dimensions.ts, 'r2', r.dimensions.bucketName, c, r.sum!.requests);
  }
  for (const r of a.r2s) add(r.dimensions.ts, 'r2', r.dimensions.bucketName, 'r2s', (r.max!.payloadSize + r.max!.metadataSize) / GB);
  for (const r of a.kv) {
    const n = names.kv.get(r.dimensions.namespaceId) ?? r.dimensions.namespaceId;
    add(r.dimensions.ts, 'kv', n, r.dimensions.actionType === 'read' ? 'kvr' : 'kvw', r.sum!.requests);
  }
  for (const r of a.queues) add(r.dimensions.ts, 'queue', names.queues.get(r.dimensions.queueId) ?? r.dimensions.queueId, 'q', r.sum!.billableOperations);
  for (const r of a.doreq) add(r.dimensions.ts, 'worker', r.dimensions.scriptName, 'do', r.sum!.requests);
  for (const r of a.dodur) {
    // activeTime is microseconds; DO namespaces belong to the script that defines the class.
    add(r.dimensions.ts, 'worker', names.dos.get(r.dimensions.namespaceId) ?? r.dimensions.namespaceId, 'dod', (r.sum!.activeTime / 1e6) * DO_GB);
  }
  for (const r of a.vecq) add(r.dimensions.ts, 'vectorize', r.dimensions.indexName, 'vecq', r.sum!.queriedVectorDimensions);
  for (const r of a.vecs) add(r.dimensions.ts, 'vectorize', r.dimensions.indexName, 'vecs', r.max!.storedVectorDimensions);

  const ai: AiRow[] = [];
  for (const r of a.ai) {
    // Workers AI analytics carry no script name, so binding traffic is attributed by model.
    const app = attribute(cfg, 'workers_ai_model', r.dimensions.modelId);
    add(r.dimensions.ts, 'workers_ai_model', r.dimensions.modelId, 'ai', r.sum!.totalNeurons);
    ai.push({
      ts: floorTo(unix(r.dimensions.ts), w.width), source: 'workers_ai', app, gateway: 'binding', provider: 'workers-ai',
      model: r.dimensions.modelId, key: r.dimensions.requestSource || 'binding',
      requests: r.count ?? 0, errors: 0, tokens_in: r.sum!.totalInputTokens, tokens_out: r.sum!.totalOutputTokens, tokens_cached: 0,
      cost_usd: (r.sum!.totalNeurons * PRICES.cloudflare.components.find((c) => c.key === 'ai')!.price), latency_ms: 0,
    });
  }
  for (const r of a.gw) {
    const d = r.dimensions, s = r.sum!, n = r.count ?? 0;
    ai.push({
      ts: floorTo(unix(d.ts), w.width), source: 'gateway', app: attribute(cfg, 'gateway', d.gateway), gateway: d.gateway,
      provider: d.provider, model: d.model, key: d.gateway,
      requests: n, errors: s.erroredRequests, tokens_in: s.tokensIn, tokens_out: s.tokensOut, tokens_cached: s.cacheReadTokens,
      cost_usd: s.cost, latency_ms: (r.quantiles?.durationMsP50 ?? 0) * n,
    });
  }
  return { cf, ai };
}
