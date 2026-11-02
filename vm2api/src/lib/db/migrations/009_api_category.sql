-- API category: sk-kin binds oauth | api. Endpoints copy CLIProxy openai-compatibility.

ALTER TABLE api_keys ADD COLUMN category TEXT NOT NULL DEFAULT 'oauth';

CREATE TABLE IF NOT EXISTS api_endpoints (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  disabled INTEGER NOT NULL DEFAULT 0,
  prefix TEXT,
  base_url TEXT NOT NULL,
  headers_json TEXT,
  disable_cooling INTEGER NOT NULL DEFAULT 0,
  priority INTEGER NOT NULL DEFAULT 0,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS api_endpoint_keys (
  id TEXT PRIMARY KEY,
  endpoint_id TEXT NOT NULL,
  api_key TEXT NOT NULL,
  proxy_url TEXT,
  disabled INTEGER NOT NULL DEFAULT 0,
  cooldown_until TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS api_endpoint_models (
  id TEXT PRIMARY KEY,
  endpoint_id TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  upstream_name TEXT NOT NULL,
  alias TEXT NOT NULL,
  image INTEGER NOT NULL DEFAULT 0,
  thinking_levels_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_api_endpoint_keys_ep ON api_endpoint_keys(endpoint_id);
CREATE INDEX IF NOT EXISTS idx_api_endpoint_models_ep ON api_endpoint_models(endpoint_id);
