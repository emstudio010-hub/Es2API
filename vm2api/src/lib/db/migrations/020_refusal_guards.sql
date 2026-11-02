-- 020_refusal_guards — cache upstream AUP/content-filter fingerprints
-- Same model + normalized prompt is blocked without another hop.

CREATE TABLE IF NOT EXISTS refusal_guards (
  fingerprint TEXT PRIMARY KEY,
  model TEXT NOT NULL DEFAULT '',
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  hit_count INTEGER NOT NULL DEFAULT 0,
  source_request_id TEXT,
  error_message TEXT,
  preview TEXT
);

CREATE INDEX IF NOT EXISTS idx_refusal_guards_model ON refusal_guards(model);
CREATE INDEX IF NOT EXISTS idx_refusal_guards_last_seen ON refusal_guards(last_seen_at);
