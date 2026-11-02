-- Endpoint kind: claude | openai | custom. Official URLs are fixed.
ALTER TABLE api_endpoints ADD COLUMN kind TEXT NOT NULL DEFAULT 'custom';
ALTER TABLE api_endpoints ADD COLUMN protocol TEXT NOT NULL DEFAULT 'anthropic';
