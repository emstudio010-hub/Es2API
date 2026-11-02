import test from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeTier,
  tierLimits,
  normalizeTiersConfig,
  isConcurrencyPinned,
} from '../../src/lib/pool/tier-limits.mjs'

const CONFIG = {
  tiers: {
    default: { max_concurrency: 20, safety_ratio: 0.95, warn_ratio: 0.85 },
    pro: { max_concurrency: 8, safety_ratio: 0.9, warn_ratio: 0.8 },
    max: { max_concurrency: 32, safety_ratio: 0.98, warn_ratio: 0.9 },
  },
}

test('unprobed tiers share the default entry', () => {
  for (const tier of ['unknown', 'none', null, undefined, '']) {
    assert.equal(normalizeTier(tier), 'default')
    assert.equal(tierLimits(CONFIG, tier).max_concurrency, 20)
  }
})

test('pro and max resolve to their own concurrency and quota lines', () => {
  const pro = tierLimits(CONFIG, 'pro')
  assert.equal(pro.max_concurrency, 8)
  assert.equal(pro.safety_ratio, 0.9)
  assert.equal(pro.limit_5h, 0.9)
  assert.equal(pro.warn_ratio, 0.8)
  const max = tierLimits(CONFIG, 'MAX')
  assert.equal(max.max_concurrency, 32)
  assert.equal(max.safety_ratio, 0.98)
  assert.equal(max.warn_ratio, 0.9)
})

test('a partial tier entry inherits the rest from default', () => {
  const cfg = { tiers: { default: CONFIG.tiers.default, pro: { max_concurrency: 4 } } }
  const pro = tierLimits(cfg, 'pro')
  assert.equal(pro.max_concurrency, 4)
  assert.equal(pro.safety_ratio, 0.95)
  assert.equal(pro.warn_ratio, 0.85)
})

test('a config predating tiers falls back to the old single values', () => {
  const legacy = {
    quota: { safety_ratio: 0.9, warn_ratio: 0.7 },
    concurrency: { default_max_per_account: 12 },
  }
  const pro = tierLimits(legacy, 'pro')
  assert.equal(pro.max_concurrency, 12)
  assert.equal(pro.safety_ratio, 0.9)
  assert.equal(pro.warn_ratio, 0.7)
})

test('a warn line above the safety line is clamped so it can still fire', () => {
  const cfg = { tiers: { pro: { max_concurrency: 8, safety_ratio: 0.8, warn_ratio: 0.95 } } }
  assert.equal(tierLimits(cfg, 'pro').warn_ratio, 0.8)
})

test('concurrency 0 is preserved rather than treated as missing', () => {
  const cfg = { tiers: { pro: { max_concurrency: 0 } }, concurrency: { default_max_per_account: 20 } }
  assert.equal(tierLimits(cfg, 'pro').max_concurrency, 0)
})

test('a slot predating the flag keeps its value; an explicitly released one follows its tier', () => {
  // Written by the VM panel — a deliberate manual pin.
  assert.equal(isConcurrencyPinned({ maxConcurrency: 8, concurrencyOverride: true }), true)
  // Written by the old global-apply — a materialised copy of the global default.
  assert.equal(isConcurrencyPinned({ maxConcurrency: 20, concurrencyOverride: false }), false)
  // Predates the flag: may be a choice made at creation, so it is honoured.
  assert.equal(isConcurrencyPinned({ maxConcurrency: 32 }), true)
  assert.equal(isConcurrencyPinned({}), false)
  assert.equal(isConcurrencyPinned(undefined), false)
  // 0 means "reject everything" and must not read as absent.
  assert.equal(isConcurrencyPinned({ maxConcurrency: 0 }), true)
})

test('normalizeTiersConfig drops unknown tiers and clamps ratios to 30%..100%', () => {
  const out = normalizeTiersConfig({
    pro: { max_concurrency: 999, safety_ratio: 1.4, warn_ratio: 0.1 },
    bogus: { max_concurrency: 5 },
  })
  assert.deepEqual(Object.keys(out), ['pro'])
  assert.equal(out.pro.max_concurrency, 256)
  assert.equal(out.pro.safety_ratio, 1)
  assert.equal(out.pro.warn_ratio, 0.3)
})
