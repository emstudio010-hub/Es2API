-- 015_api_keys_sub2api — align api_keys with the sub2api APIKey shape.
--
-- Additive where possible; only the legacy request-count quota column is
-- renamed (quota_used → quota_requests_used) so the sub2api USD pair
-- (quota / quota_used) can take the canonical names.
-- user_id stays NULL-able: existing keys are backfilled to the seeded admin
-- at startup (ensureDefaultAdmin), not inside the migration.

ALTER TABLE api_keys RENAME COLUMN quota_used TO quota_requests_used;

ALTER TABLE api_keys ADD COLUMN user_id TEXT;
ALTER TABLE api_keys ADD COLUMN group_id INTEGER;
ALTER TABLE api_keys ADD COLUMN quota REAL NOT NULL DEFAULT 0;
ALTER TABLE api_keys ADD COLUMN quota_used REAL NOT NULL DEFAULT 0;
ALTER TABLE api_keys ADD COLUMN rate_limit_5h REAL NOT NULL DEFAULT 0;
ALTER TABLE api_keys ADD COLUMN rate_limit_1d REAL NOT NULL DEFAULT 0;
ALTER TABLE api_keys ADD COLUMN rate_limit_7d REAL NOT NULL DEFAULT 0;
ALTER TABLE api_keys ADD COLUMN usage_5h REAL NOT NULL DEFAULT 0;
ALTER TABLE api_keys ADD COLUMN usage_1d REAL NOT NULL DEFAULT 0;
ALTER TABLE api_keys ADD COLUMN usage_7d REAL NOT NULL DEFAULT 0;
ALTER TABLE api_keys ADD COLUMN window_5h_start TEXT;
ALTER TABLE api_keys ADD COLUMN window_1d_start TEXT;
ALTER TABLE api_keys ADD COLUMN window_7d_start TEXT;
ALTER TABLE api_keys ADD COLUMN ip_whitelist TEXT;
ALTER TABLE api_keys ADD COLUMN ip_blacklist TEXT;
ALTER TABLE api_keys ADD COLUMN deleted_at TEXT;

-- all existing keys join the coding group (id=1)
UPDATE api_keys SET group_id = 1 WHERE group_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_group ON api_keys(group_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_status ON api_keys(status);
CREATE INDEX IF NOT EXISTS idx_api_keys_deleted_at ON api_keys(deleted_at);
CREATE INDEX IF NOT EXISTS idx_api_keys_expires ON api_keys(expires_at);
