import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { numberFingerprintBank, compareNumberFingerprint } from '../src/number-fingerprint.mjs'
import { Store } from '../src/store.mjs'
import { AccountPool } from '../src/account-pool.mjs'
import { ModelTrace } from '../src/modeltrace.mjs'

const golden = JSON.parse(fs.readFileSync(new URL('../resources/modeltrace/cpa-v2/golden.json', import.meta.url), 'utf8'))

test('pinned CPA detector matches all golden rankings and calibrated probabilities', () => {
  const bank = numberFingerprintBank()
  assert.equal(bank.models.length, 60)
  assert.equal(bank.challenges.length, 36)
  assert.equal(new Set(bank.challenges.map(item => item.id)).size, 36)
  assert.equal(bank.aliases['gpt-6.1-sol'], 'gpt-6-astra')
  for (const row of golden) {
    const actual = compareNumberFingerprint(row.outputs, row.expected.prediction || 'gpt-6.1-sol')
    assert.equal(actual.prediction, row.expected.prediction)
    assert.equal(actual.used_outputs, row.expected.used_outputs)
    assert.equal(actual.decision || '', row.expected.decision)
    if (row.expected.probability === null) assert.equal(actual.confidence, null)
    else assert.ok(Math.abs(actual.confidence - row.expected.probability) < 1e-10)
    for (const [index, result] of actual.results.entries()) {
      assert.equal(result.model, row.expected.results[index].model)
      assert.ok(Math.abs(result.score - row.expected.results[index].score) < 1e-10)
    }
  }
})

test('short, rejected and programmatic samples cannot penalize an account', () => {
  for (const samples of [golden[0].outputs.slice(0, 1), [{ text: 'Refused' }, { text: '1 2' }, { text: '3' }]]) {
    const result = compareNumberFingerprint(samples, 'gpt-6.1-sol')
    assert.equal(result.status, 'insufficient_samples')
    assert.equal(result.actionable, false)
  }
  const unknown = compareNumberFingerprint(golden[0].outputs, 'unknown-model')
  assert.equal(unknown.status, 'unlisted_model')
  assert.equal(unknown.actionable, false)
})

test('empty deployment has a built-in bank and reports missing runner and slot before sampling', () => {
  const store = new Store({ encryptionKey: 'ab'.repeat(32) })
  try {
    const pool = new AccountPool({ store, lifecycle: {} })
    const trace = new ModelTrace({ store, accountPool: pool })
    assert.equal(trace.bank().ready, true)
    assert.deepEqual(trace.readiness().blockers, ['trace_runner_unavailable', 'trace_account_missing'])
    trace.configureGlobal({ sample_count: 4 })
    assert.ok(trace.readiness().blockers.includes('trace_challenges_insufficient'))
  } finally { store.close() }
})
