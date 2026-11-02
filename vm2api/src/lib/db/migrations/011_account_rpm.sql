-- Per-account RPM cap (0 = unlimited) and manual override flag.
-- 0 = follow the routing tier limit (pro / max / default), 1 = manual per-VM value.
ALTER TABLE accounts ADD COLUMN max_rpm INTEGER NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN rpm_override INTEGER NOT NULL DEFAULT 0;
