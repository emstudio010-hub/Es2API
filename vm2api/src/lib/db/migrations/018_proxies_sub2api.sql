-- 018_proxies_sub2api — align proxies with the sub2api Proxy shape.
--
-- TEXT id stays (ProxyPool generates px-xxxx ids and panel references them).
-- scheme → protocol rename plus name/updated_at/deleted_at. `enabled` is
-- kept as the admin switch; `status` remains the probe state (unknown/ok/dead)
-- — merging them would lose the ProxyPool's `!enabled || status==='dead'`
-- semantics.

ALTER TABLE proxies RENAME COLUMN scheme TO protocol;
ALTER TABLE proxies ADD COLUMN name TEXT NOT NULL DEFAULT '';
ALTER TABLE proxies ADD COLUMN updated_at TEXT;
ALTER TABLE proxies ADD COLUMN deleted_at TEXT;

UPDATE proxies SET name = COALESCE(
  NULLIF(name, ''),
  CASE WHEN host IS NOT NULL AND port IS NOT NULL THEN host || ':' || CAST(port AS TEXT) END,
  id
);

CREATE INDEX IF NOT EXISTS idx_proxies_status ON proxies(status);
CREATE INDEX IF NOT EXISTS idx_proxies_deleted_at ON proxies(deleted_at);
