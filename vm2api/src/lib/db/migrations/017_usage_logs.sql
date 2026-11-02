-- 017_usage_logs — rename request_logs to the sub2api usage_logs shape.
--
-- Table + column renames keep all data and the unique request_id index.
-- New columns: user_id/group_id ownership, actual_cost (total_cost ×
-- group.rate_multiplier at write time) and the multiplier snapshot.
-- Token columns stay NULL-able in DDL (SQLite can't retighten constraints
-- without a full rebuild); NULLs are normalized to 0 here and the repo
-- writes 0 from now on. request_log_debug is untouched.

ALTER TABLE request_logs RENAME TO usage_logs;
ALTER TABLE usage_logs RENAME COLUMN ts TO created_at;
ALTER TABLE usage_logs RENAME COLUMN ip TO ip_address;

ALTER TABLE usage_logs ADD COLUMN user_id TEXT;
ALTER TABLE usage_logs ADD COLUMN group_id INTEGER;
ALTER TABLE usage_logs ADD COLUMN actual_cost REAL;
ALTER TABLE usage_logs ADD COLUMN rate_multiplier REAL;

-- historical rows: coding group (id=1, rate 1.0), actual = official cost.
-- user_id stays NULL — pre-migration keys had no owner to attribute.
UPDATE usage_logs SET group_id = 1, rate_multiplier = 1.0, actual_cost = total_cost
WHERE group_id IS NULL;

UPDATE usage_logs SET
  input_tokens             = COALESCE(input_tokens, 0),
  output_tokens            = COALESCE(output_tokens, 0),
  cache_read_tokens        = COALESCE(cache_read_tokens, 0),
  cache_creation_tokens    = COALESCE(cache_creation_tokens, 0),
  cache_creation_5m_tokens = COALESCE(cache_creation_5m_tokens, 0),
  cache_creation_1h_tokens = COALESCE(cache_creation_1h_tokens, 0);

CREATE INDEX IF NOT EXISTS idx_usage_logs_user_created ON usage_logs(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_usage_logs_group_created ON usage_logs(group_id, created_at);
