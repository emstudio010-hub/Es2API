export type DatabaseRuntimeMetrics = {
  ok: boolean
  engine: 'sqlite'
  probe_latency_ms: number | null
  journal_mode: string | null
  synchronous: number | null
  foreign_keys: boolean | null
  busy_timeout_ms: number | null
  file_size_bytes: number | null
  wal_size_bytes: number | null
  shm_size_bytes: number | null
  page_size_bytes: number | null
  page_count: number | null
  freelist_pages: number | null
  used_pages: number | null
  used_bytes: number | null
  free_ratio: number | null
  migration_count: number | null
  latest_migration: string | null
  latest_migration_at: string | null
}

export type UsageCacheMetrics = {
  since: string
  entries_total: number
  entries_fresh: number
  entries_stale: number
  inflight: number
  requests: number
  success_hits: number
  error_hits: number
  misses: number
  singleflight_joins: number
  upstream_fetches: number
  upstream_failures: number
  hit_rate: number | null
  reuse_rate: number | null
  success_ttl_ms: number
  error_ttl_ms: number
}

export type DatabaseMetricsPayload = {
  sampled_at: string | null
  database: DatabaseRuntimeMetrics
  usage_cache: UsageCacheMetrics | null
}
