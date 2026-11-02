-- Ingress 401 (invalid / missing key) keeps the presented token in plaintext
-- so the logs page can show who is hammering the gateway. Valid keys stay
-- on api_key_id only.

ALTER TABLE request_logs ADD COLUMN api_key_presented TEXT;
CREATE INDEX IF NOT EXISTS idx_reqlog_status ON request_logs(status, ts DESC);
