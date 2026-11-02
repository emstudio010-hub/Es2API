import test from 'node:test'
import assert from 'node:assert/strict'
import { createUsageCache, API_CACHE_TTL_MS, API_ERROR_CACHE_TTL_MS } from '../../src/lib/oauth/usage-cache.mjs'

function clock(start = 1_000_000) {
  let now = start
  return {
    now: () => now,
    advance(ms) {
      now += ms
    },
  }
}

test('3min success hit does not hop again; force still uses the success TTL', async () => {
  const t = clock()
  let hops = 0
  const cache = createUsageCache({ now: t.now, jitter: false })
  const fetcher = async () => {
    hops += 1
    return { ok: true, five_hour: { utilization: 0.4 } }
  }
  const first = await cache.load('acc-1', fetcher)
  const second = await cache.load('acc-1', fetcher, { force: true })
  assert.equal(first.five_hour.utilization, 0.4)
  assert.equal(second.five_hour.utilization, 0.4)
  assert.equal(hops, 1)
  t.advance(API_CACHE_TTL_MS + 1)
  await cache.load('acc-1', fetcher)
  assert.equal(hops, 2)
})

test('429 is negatively cached for 1min; force can replace the error', async () => {
  const t = clock()
  let hops = 0
  const cache = createUsageCache({ now: t.now, jitter: false })
  const fetcher = async () => {
    hops += 1
    if (hops === 1) return { ok: false, usage_status: 429, rate_limited: true }
    return { ok: true, five_hour: { utilization: 0.2 } }
  }
  const first = await cache.load('acc-429', fetcher)
  const second = await cache.load('acc-429', fetcher)
  assert.equal(first.rate_limited, true)
  assert.equal(second.rate_limited, true)
  assert.equal(hops, 1)
  const forced = await cache.load('acc-429', fetcher, { force: true })
  assert.equal(forced.ok, true)
  assert.equal(hops, 2)
  t.advance(API_ERROR_CACHE_TTL_MS + 1)
})

test('concurrent loads singleflight into one hop', async () => {
  let hops = 0
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const cache = createUsageCache({ jitter: false })
  const fetcher = async () => {
    hops += 1
    await gate
    return { ok: true, five_hour: { utilization: 0.11 } }
  }
  const a = cache.load('acc-sf', fetcher)
  const b = cache.load('acc-sf', fetcher)
  release()
  const [ra, rb] = await Promise.all([a, b])
  assert.equal(hops, 1)
  assert.equal(ra.five_hour.utilization, 0.11)
  assert.equal(rb.five_hour.utilization, 0.11)
})

test('stats classifies direct hits, misses, joins and upstream failures once per load', async () => {
  const t = clock()
  const cache = createUsageCache({ now: t.now, jitter: false })
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  let hops = 0
  const fetcher = async () => {
    hops += 1
    if (hops === 1) return { ok: false, usage_status: 429, rate_limited: true }
    if (hops === 2) {
      await gate
      return { ok: true, five_hour: { utilization: 0.1 } }
    }
    throw new Error('unexpected fetch')
  }

  await cache.load('acc-metrics', fetcher)
  await cache.load('acc-metrics', fetcher)
  const forced = cache.load('acc-metrics', fetcher, { force: true })
  const joined = cache.load('acc-metrics', fetcher, { force: true })
  release()
  await Promise.all([forced, joined])
  await cache.load('acc-metrics', fetcher)

  assert.deepEqual(cache.stats(), {
    since: new Date(1_000_000).toISOString(),
    entries_total: 1,
    entries_fresh: 1,
    entries_stale: 0,
    inflight: 0,
    requests: 5,
    success_hits: 1,
    error_hits: 1,
    misses: 2,
    singleflight_joins: 1,
    upstream_fetches: 2,
    upstream_failures: 1,
    hit_rate: 0.4,
    reuse_rate: 0.6,
    success_ttl_ms: API_CACHE_TTL_MS,
    error_ttl_ms: API_ERROR_CACHE_TTL_MS,
  })
})

test('stats distinguish stale entries from zero traffic and clear keeps cumulative counters', async () => {
  const t = clock()
  const cache = createUsageCache({ now: t.now, jitter: false })
  const empty = cache.stats()
  assert.equal(empty.requests, 0)
  assert.equal(empty.hit_rate, null)
  assert.equal(empty.reuse_rate, null)

  await cache.load('acc-stale', async () => ({ ok: true }))
  t.advance(API_CACHE_TTL_MS + 1)
  assert.equal(cache.stats().entries_fresh, 0)
  assert.equal(cache.stats().entries_stale, 1)

  cache.clear()
  const cleared = cache.stats()
  assert.equal(cleared.entries_total, 0)
  assert.equal(cleared.requests, 1)
  assert.equal(cleared.misses, 1)
  assert.equal(cleared.upstream_fetches, 1)
})

test('thrown upstream errors are negatively cached and counted once', async () => {
  const cache = createUsageCache({ jitter: false })
  let hops = 0
  const fetcher = async () => {
    hops += 1
    throw new Error('upstream down')
  }

  await assert.rejects(cache.load('acc-throw', fetcher), /upstream down/)
  await assert.rejects(cache.load('acc-throw', fetcher), /upstream down/)
  const stats = cache.stats()
  assert.equal(hops, 1)
  assert.equal(stats.requests, 2)
  assert.equal(stats.misses, 1)
  assert.equal(stats.error_hits, 1)
  assert.equal(stats.upstream_fetches, 1)
  assert.equal(stats.upstream_failures, 1)
})
