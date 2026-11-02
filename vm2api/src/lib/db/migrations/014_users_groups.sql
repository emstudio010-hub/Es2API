-- 014_users_groups — sub2api-style user/group/redeem tables.
--
-- users absorbs panel_users (console operators become first-class users with
-- balance/concurrency). groups is a fixed 2-row dictionary: coding (default)
-- and other. account_groups links upstream accounts (TEXT ids) to groups.
-- redeem_codes is the balance top-up ledger (sub2api baseline shape).

-- users (sub2api users + kin panel roles; TEXT id keeps panel sessions valid)
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  username TEXT NOT NULL COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  balance REAL NOT NULL DEFAULT 0,
  concurrency INTEGER NOT NULL DEFAULT 5,
  status TEXT NOT NULL DEFAULT 'active',
  notes TEXT NOT NULL DEFAULT '',
  last_login_at TEXT,
  last_active_at TEXT,
  created_at TEXT,
  updated_at TEXT,
  deleted_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_active
  ON users(username) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_active
  ON users(email) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);
CREATE INDEX IF NOT EXISTS idx_users_deleted_at ON users(deleted_at);

-- groups — fixed dictionary: coding (id=1, default) / other (id=2)
CREATE TABLE IF NOT EXISTS groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  rate_multiplier REAL NOT NULL DEFAULT 1.0,
  is_exclusive INTEGER NOT NULL DEFAULT 0,
  platform TEXT NOT NULL DEFAULT 'claude',
  rpm_limit INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT,
  updated_at TEXT,
  deleted_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_groups_name_active
  ON groups(name) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_groups_status ON groups(status);
CREATE INDEX IF NOT EXISTS idx_groups_deleted_at ON groups(deleted_at);

INSERT INTO groups (id, name, description, sort_order, created_at, updated_at)
VALUES
  (1, 'coding', 'Coding pool (default)', 0, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  (2, 'other',  'Other traffic',         1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));

-- account_groups — account↔group M2M (account ids are upstream TEXT UUIDs)
CREATE TABLE IF NOT EXISTS account_groups (
  account_id TEXT NOT NULL,
  group_id INTEGER NOT NULL,
  priority INTEGER NOT NULL DEFAULT 50,
  created_at TEXT,
  PRIMARY KEY (account_id, group_id)
);
CREATE INDEX IF NOT EXISTS idx_account_groups_group ON account_groups(group_id);
CREATE INDEX IF NOT EXISTS idx_account_groups_priority ON account_groups(priority);

-- redeem_codes — balance top-up codes (sub2api baseline)
CREATE TABLE IF NOT EXISTS redeem_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL DEFAULT 'balance',
  value REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'unused',
  used_by TEXT,
  used_at TEXT,
  notes TEXT,
  expires_at TEXT,
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_redeem_codes_status ON redeem_codes(status);
CREATE INDEX IF NOT EXISTS idx_redeem_codes_used_by ON redeem_codes(used_by);

-- panel_users → users (role map is identity: admin/super/user; email placeholder)
INSERT INTO users (id, email, username, password_hash, role, status,
                   last_login_at, created_at, updated_at)
SELECT id,
       username || '@panel.local',
       username,
       password_hash,
       role,
       CASE WHEN enabled = 1 THEN 'active' ELSE 'disabled' END,
       last_login_at, created_at, updated_at
FROM panel_users;

ALTER TABLE panel_users RENAME TO panel_users_legacy;

-- seed all existing accounts into the coding group
INSERT OR IGNORE INTO account_groups (account_id, group_id, priority, created_at)
SELECT account_id, 1, 50, strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM accounts;
