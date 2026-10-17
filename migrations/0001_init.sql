-- AI usage facts. One row per (bucket, source, app, gateway, provider, model, key).
-- Collectors re-pull overlapping windows and REPLACE rows, so writes are idempotent.
CREATE TABLE ai_5m (
  ts INTEGER NOT NULL, source TEXT NOT NULL, app TEXT NOT NULL, gateway TEXT NOT NULL,
  provider TEXT NOT NULL, model TEXT NOT NULL, key TEXT NOT NULL,
  requests REAL NOT NULL DEFAULT 0, errors REAL NOT NULL DEFAULT 0,
  tokens_in REAL NOT NULL DEFAULT 0, tokens_out REAL NOT NULL DEFAULT 0, tokens_cached REAL NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0, latency_ms REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (ts, source, app, gateway, provider, model, key)
) WITHOUT ROWID;
CREATE TABLE ai_1h AS SELECT * FROM ai_5m WHERE 0;
CREATE UNIQUE INDEX ai_1h_pk ON ai_1h (ts, source, app, gateway, provider, model, key);
CREATE TABLE ai_1d AS SELECT * FROM ai_5m WHERE 0;
CREATE UNIQUE INDEX ai_1d_pk ON ai_1d (ts, source, app, gateway, provider, model, key);

-- Cloudflare platform usage, in billing units (see config/prices.json components).
CREATE TABLE cf_5m (
  ts INTEGER NOT NULL, app TEXT NOT NULL, component TEXT NOT NULL, resource TEXT NOT NULL,
  units REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (ts, app, component, resource)
) WITHOUT ROWID;
CREATE TABLE cf_1h AS SELECT * FROM cf_5m WHERE 0;
CREATE UNIQUE INDEX cf_1h_pk ON cf_1h (ts, app, component, resource);
CREATE TABLE cf_1d AS SELECT * FROM cf_5m WHERE 0;
CREATE UNIQUE INDEX cf_1d_pk ON cf_1d (ts, app, component, resource);

-- Provider-reported daily cost (the invoice view), for reconciliation against estimates.
CREATE TABLE provider_cost_1d (
  ts INTEGER NOT NULL, provider TEXT NOT NULL, scope TEXT NOT NULL, description TEXT NOT NULL,
  cost_usd REAL NOT NULL,
  PRIMARY KEY (ts, provider, scope, description)
) WITHOUT ROWID;

-- Last run per collector, shown in the UI so stale data is visible.
CREATE TABLE collector_runs (
  source TEXT PRIMARY KEY, ran_at INTEGER NOT NULL, ok INTEGER NOT NULL, rows INTEGER NOT NULL, message TEXT
);
