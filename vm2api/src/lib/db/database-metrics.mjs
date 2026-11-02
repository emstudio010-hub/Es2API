import fs from 'node:fs'

function numberOrNull(value) {
  if (value == null || value === '') return null
  const num = Number(value)
  return Number.isFinite(num) ? num : null
}

function scalar(db, sql) {
  try {
    const row = db.prepare(sql).get()
    if (!row || typeof row !== 'object') return null
    return Object.values(row)[0] ?? null
  } catch {
    return null
  }
}

function probe(db, clock) {
  try {
    const startedAt = clock()
    db.prepare('SELECT 1 AS ok').get()
    const elapsed = numberOrNull(clock() - startedAt)
    return {
      ok: true,
      latencyMs: elapsed == null ? null : Math.round(Math.max(elapsed, 0) * 1000) / 1000,
    }
  } catch {
    return { ok: false, latencyMs: null }
  }
}

function fileSize(dbPath, suffix = '') {
  if (typeof dbPath !== 'string' || !dbPath) return null
  try {
    return fs.statSync(`${dbPath}${suffix}`).size
  } catch (error) {
    return error?.code === 'ENOENT' ? 0 : null
  }
}

function migrationMetrics(db) {
  const count = numberOrNull(scalar(db, 'SELECT COUNT(*) AS count FROM schema_migrations'))
  let latest = null
  try {
    latest = db
      .prepare('SELECT version, applied_at FROM schema_migrations ORDER BY applied_at DESC, version DESC LIMIT 1')
      .get()
  } catch {}
  return {
    migration_count: count,
    latest_migration: latest?.version == null ? null : String(latest.version),
    latest_migration_at: latest?.applied_at == null ? null : String(latest.applied_at),
  }
}

function pageMetrics(pageSize, pageCount, freelistPages) {
  if (pageCount == null || freelistPages == null) {
    return { used_pages: null, used_bytes: null, free_ratio: null }
  }
  const usedPages = Math.max(pageCount - freelistPages, 0)
  return {
    used_pages: usedPages,
    used_bytes: pageSize == null ? null : usedPages * pageSize,
    free_ratio: pageCount > 0 ? freelistPages / pageCount : null,
  }
}

function safeUsageStats(usageCache) {
  try {
    return typeof usageCache?.stats === 'function' ? usageCache.stats() : null
  } catch {
    return null
  }
}

function sampledAt(now) {
  try {
    return new Date(now()).toISOString()
  } catch {
    return null
  }
}

export function snapshotDatabaseMetrics({
  db,
  dbPath,
  usageCache,
  now = () => Date.now(),
  clock = () => performance.now(),
}) {
  const health = probe(db, clock)
  const journalMode = scalar(db, 'PRAGMA journal_mode')
  const foreignKeys = numberOrNull(scalar(db, 'PRAGMA foreign_keys'))
  const pageSize = numberOrNull(scalar(db, 'PRAGMA page_size'))
  const pageCount = numberOrNull(scalar(db, 'PRAGMA page_count'))
  const freelistPages = numberOrNull(scalar(db, 'PRAGMA freelist_count'))

  return {
    sampled_at: sampledAt(now),
    database: {
      ok: health.ok,
      engine: 'sqlite',
      probe_latency_ms: health.latencyMs,
      journal_mode: journalMode == null ? null : String(journalMode).toLowerCase(),
      synchronous: numberOrNull(scalar(db, 'PRAGMA synchronous')),
      foreign_keys: foreignKeys == null ? null : foreignKeys !== 0,
      busy_timeout_ms: numberOrNull(scalar(db, 'PRAGMA busy_timeout')),
      file_size_bytes: fileSize(dbPath),
      wal_size_bytes: fileSize(dbPath, '-wal'),
      shm_size_bytes: fileSize(dbPath, '-shm'),
      page_size_bytes: pageSize,
      page_count: pageCount,
      freelist_pages: freelistPages,
      ...pageMetrics(pageSize, pageCount, freelistPages),
      ...migrationMetrics(db),
    },
    usage_cache: safeUsageStats(usageCache),
  }
}
