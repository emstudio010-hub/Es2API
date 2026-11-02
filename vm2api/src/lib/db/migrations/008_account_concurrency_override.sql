-- Per-account concurrency override flag.
-- 0 = follow the routing tier limit (pro / max / default), 1 = manual per-VM value.
ALTER TABLE accounts ADD COLUMN concurrency_override INTEGER NOT NULL DEFAULT 0;
