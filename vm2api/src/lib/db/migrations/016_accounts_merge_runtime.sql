-- 016_accounts_merge_runtime — sub2api Account shape; runtime state merged in.
--
-- accounts absorbs the persistent scheduling columns that previously lived in
-- account_runtime_states (SSOT fix). The high-frequency worker columns move to
-- a thin account_runtime table. Timestamps are ISO-8601 TEXT (runtime kept ms
-- epoch INTEGERs; converted here). `type` defaults to 'oauth'; the accurate
-- credential kind (oauth / setup-token / apikey) is stamped by the runtime
-- write-through from credential-mode.mjs, not guessed in SQL.
--
-- Rollback safety: accounts_legacy snapshot + account_runtime_states_legacy.

CREATE TABLE accounts_legacy AS SELECT * FROM accounts;

ALTER TABLE accounts RENAME COLUMN account_id TO id;
ALTER TABLE accounts RENAME COLUMN max_concurrency TO concurrency;

ALTER TABLE accounts ADD COLUMN name TEXT NOT NULL DEFAULT '';
ALTER TABLE accounts ADD COLUMN platform TEXT NOT NULL DEFAULT 'claude';
ALTER TABLE accounts ADD COLUMN type TEXT NOT NULL DEFAULT 'oauth';
ALTER TABLE accounts ADD COLUMN credentials TEXT NOT NULL DEFAULT '{}';
ALTER TABLE accounts ADD COLUMN extra TEXT NOT NULL DEFAULT '{}';
ALTER TABLE accounts ADD COLUMN proxy_id TEXT;
ALTER TABLE accounts ADD COLUMN load_factor INTEGER;
ALTER TABLE accounts ADD COLUMN priority INTEGER NOT NULL DEFAULT 50;
ALTER TABLE accounts ADD COLUMN rate_multiplier REAL NOT NULL DEFAULT 1.0;
ALTER TABLE accounts ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE accounts ADD COLUMN error_message TEXT;
ALTER TABLE accounts ADD COLUMN last_used_at TEXT;
ALTER TABLE accounts ADD COLUMN expires_at TEXT;
ALTER TABLE accounts ADD COLUMN schedulable INTEGER NOT NULL DEFAULT 1;
ALTER TABLE accounts ADD COLUMN rate_limited_at TEXT;
ALTER TABLE accounts ADD COLUMN rate_limit_reset_at TEXT;
ALTER TABLE accounts ADD COLUMN overload_until TEXT;
ALTER TABLE accounts ADD COLUMN temp_unschedulable_until TEXT;
ALTER TABLE accounts ADD COLUMN temp_unschedulable_reason TEXT;
ALTER TABLE accounts ADD COLUMN session_window_start TEXT;
ALTER TABLE accounts ADD COLUMN session_window_end TEXT;
ALTER TABLE accounts ADD COLUMN session_window_status TEXT;
ALTER TABLE accounts ADD COLUMN created_at TEXT;
ALTER TABLE accounts ADD COLUMN deleted_at TEXT;

-- name defaults to email (panel display), else the account id
UPDATE accounts SET name = COALESCE(NULLIF(email, ''), id) WHERE name = '';

-- fold the three JSON snapshot columns into sub2api-style `extra`
UPDATE accounts SET extra = json_object(
  'unified',             CASE WHEN unified_json             IS NOT NULL AND json_valid(unified_json)             THEN json(unified_json)             ELSE NULL END,
  'last_blocked',        CASE WHEN last_blocked_json        IS NOT NULL AND json_valid(last_blocked_json)        THEN json(last_blocked_json)        ELSE NULL END,
  'last_cli_rate_limit', CASE WHEN last_cli_rate_limit_json IS NOT NULL AND json_valid(last_cli_rate_limit_json) THEN json(last_cli_rate_limit_json) ELSE NULL END
);

ALTER TABLE accounts DROP COLUMN unified_json;
ALTER TABLE accounts DROP COLUMN last_blocked_json;
ALTER TABLE accounts DROP COLUMN last_cli_rate_limit_json;

-- orphan runtime rows (no accounts row) get a minimal accounts row first so
-- the scheduling-state merge below cannot silently drop them
INSERT INTO accounts (id, vm_id, extra, name, created_at, updated_at)
SELECT r.account_id, r.vm_id, '{}', r.account_id,
       strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM account_runtime_states r
WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.id = r.account_id);

-- merge persistent scheduling state from account_runtime_states
-- (ms-epoch INTEGERs → ISO-8601 TEXT; weight becomes load_factor)
UPDATE accounts SET
  priority                 = COALESCE(r.priority, accounts.priority),
  load_factor              = r.weight,
  last_used_at             = CASE WHEN r.last_used_at        IS NOT NULL THEN strftime('%Y-%m-%dT%H:%M:%fZ', r.last_used_at / 1000.0, 'unixepoch')        ELSE accounts.last_used_at END,
  rate_limited_at          = CASE WHEN r.rate_limited_at     IS NOT NULL THEN strftime('%Y-%m-%dT%H:%M:%fZ', r.rate_limited_at / 1000.0, 'unixepoch')     ELSE NULL END,
  rate_limit_reset_at      = CASE WHEN r.rate_limit_reset_at IS NOT NULL THEN strftime('%Y-%m-%dT%H:%M:%fZ', r.rate_limit_reset_at / 1000.0, 'unixepoch') ELSE NULL END,
  overload_until           = CASE WHEN r.overload_until      IS NOT NULL THEN strftime('%Y-%m-%dT%H:%M:%fZ', r.overload_until / 1000.0, 'unixepoch')      ELSE NULL END,
  temp_unschedulable_until = CASE WHEN r.cooldown_until      IS NOT NULL THEN strftime('%Y-%m-%dT%H:%M:%fZ', r.cooldown_until / 1000.0, 'unixepoch')      ELSE NULL END,
  temp_unschedulable_reason = r.cooldown_reason,
  session_window_start     = CASE WHEN r.session_window_start IS NOT NULL THEN strftime('%Y-%m-%dT%H:%M:%fZ', r.session_window_start / 1000.0, 'unixepoch') ELSE NULL END,
  session_window_end       = CASE WHEN r.session_window_end   IS NOT NULL THEN strftime('%Y-%m-%dT%H:%M:%fZ', r.session_window_end / 1000.0, 'unixepoch')   ELSE NULL END,
  session_window_status    = r.session_window_status
FROM account_runtime_states r
WHERE r.account_id = accounts.id;

-- thin runtime table: worker heartbeat + per-model transient state only
CREATE TABLE IF NOT EXISTS account_runtime (
  account_id TEXT PRIMARY KEY,
  vm_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unknown',
  model_states_json TEXT,
  credential_generation INTEGER NOT NULL DEFAULT 0,
  refresh_status TEXT,
  worker_heartbeat_at INTEGER,
  worker_status_json TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_account_runtime_vm_new ON account_runtime(vm_id);

INSERT INTO account_runtime (account_id, vm_id, status, model_states_json,
                             credential_generation, refresh_status,
                             worker_heartbeat_at, worker_status_json, updated_at)
SELECT account_id, vm_id, status, model_states_json,
       credential_generation, refresh_status,
       worker_heartbeat_at, worker_status_json, updated_at
FROM account_runtime_states;

ALTER TABLE account_runtime_states RENAME TO account_runtime_states_legacy;

-- accounts materialized in this migration (orphan runtime rows) also join coding
INSERT OR IGNORE INTO account_groups (account_id, group_id, priority, created_at)
SELECT id, 1, 50, strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM accounts;

CREATE INDEX IF NOT EXISTS idx_accounts_status ON accounts(status);
CREATE INDEX IF NOT EXISTS idx_accounts_schedulable ON accounts(schedulable);
CREATE INDEX IF NOT EXISTS idx_accounts_priority ON accounts(priority);
CREATE INDEX IF NOT EXISTS idx_accounts_deleted_at ON accounts(deleted_at);
CREATE INDEX IF NOT EXISTS idx_accounts_type ON accounts(type);
