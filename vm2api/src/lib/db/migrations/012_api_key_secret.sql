-- Managed sk-kin plaintext kept for panel re-copy. Encrypted at rest when
-- KIN_DB_SECRET is set; `key_hash` stays the only auth lookup path.

ALTER TABLE api_keys ADD COLUMN key_secret TEXT;
