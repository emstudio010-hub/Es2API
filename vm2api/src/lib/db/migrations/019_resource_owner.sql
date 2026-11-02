-- 019_resource_owner — tenant owner on users/proxies/vms
--
-- VM SSOT remains vms/*.json; SQLite columns are a mirror for joins.
-- vm_create_quota only counts origin=user_created slots.

ALTER TABLE users ADD COLUMN vm_create_quota INTEGER NOT NULL DEFAULT 0;

ALTER TABLE proxies ADD COLUMN owner_user_id TEXT;
CREATE INDEX IF NOT EXISTS idx_proxies_owner ON proxies(owner_user_id);

ALTER TABLE vms ADD COLUMN owner_user_id TEXT;
ALTER TABLE vms ADD COLUMN origin TEXT NOT NULL DEFAULT 'platform';
CREATE INDEX IF NOT EXISTS idx_vms_owner ON vms(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_vms_origin ON vms(origin);
