import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Store } from '../src/store.mjs'
import { AccountPool } from '../src/account-pool.mjs'
import { ModelTrace } from '../src/modeltrace.mjs'
import { createIntegrationServer } from '../src/server.mjs'

const encryptionKey = 'ac'.repeat(32)
const accountId = 'automation-account'
const vmId = `vm-${accountId}`
const fixture = {
  challenges: [1, 2, 3].map(n => ({ id: `challenge-${n}`, prompt: `Synthetic challenge ${n}` })),
  models: ['model-a', 'model-b'].map(id => ({ id, responses: [1, 2, 3].map(n => ({
    challenge_id: `challenge-${n}`, text: `${id} reference answer number ${n}`,
  })) })),
}
const outputFor = challenge => ({ text: fixture.models[0].responses.find(item => item.challenge_id === challenge.id).text })
const event = (id, overrides = {}) => ({ event_id: id, vm_id: vmId, source: 'vm2', model: 'model-a', upstream_model: 'model-a', success: true, ...overrides })

async function setup(t, { filename = ':memory:', runner = async ({ challenge }) => outputFor(challenge), clock, bridge = true } = {}) {
  const store = new Store({ filename, encryptionKey })
  const pool = new AccountPool({ store, lifecycle: {
    async provision(binding) { return { vm_id: `vm-${binding.account_id}`, slot: { status: 'running', ready: true } } },
    async remove() {},
  } })
  const trace = new ModelTrace({ store, accountPool: pool, runner, clock, usageBridgeConfigured: bridge })
  pool.createGroup({ id: 'automation-group', name: 'Automation fixture' })
  await pool.importAccount({ account_id: accountId, group_ids: ['automation-group'], credential: { access_token: 'synthetic-test-token' } })
  trace.installBank(fixture)
  trace.configureGlobal({ model: 'model-a', every_requests: 2 })
  let closed = false
  const close = async () => { if (!closed) { closed = true; await trace.close(); store.close() } }
  t.after(close)
  return { store, pool, trace, close, account: () => pool.getAccount(accountId) }
}

test('VM2 usage validates binding and persistently deduplicates events without counting failures', async t => {
  let now = Date.parse('2026-10-31T08:00:00Z')
  const { store, trace, account } = await setup(t, { clock: () => now })
  trace.configureGlobal({ every_requests: 100 })
  assert.equal(await trace.recordUsage(event('success-1')), null)
  assert.equal(await trace.recordUsage(event('success-1')), null)
  assert.equal(account().successful_requests, 1)
  assert.equal(store.accountModelUsage(accountId)[0].requests, 1)
  await assert.rejects(trace.recordUsage(event('success-1', { model: 'model-b' })), { code: 'usage_event_conflict' })
  await assert.rejects(trace.recordUsage(event('wrong-binding', { account_id: 'different-account' })), { code: 'usage_binding_conflict' })
  await assert.rejects(trace.recordUsage(event('invalid/id')), { code: 'invalid_usage_event' })
  assert.equal(await trace.recordUsage(event('unowned-slot', { vm_id: 'external-slot' })), null)
  const lastSuccess = account().modeltrace.state.last_usage_at
  now += 60_000
  assert.equal(await trace.recordUsage(event('failed-1', { success: false })), null)
  assert.equal(await trace.recordUsage(event('failed-1', { success: false })), null)
  assert.equal(account().successful_requests, 1)
  assert.equal(account().modeltrace.state.last_usage_at, lastSuccess)
  const usage = store.accountModelUsage(accountId)[0]
  assert.equal(usage.requests, 2)
  assert.equal(usage.successful, 1)
  assert.equal(store.listRuns({}).total, 0)
  const summary = trace.summary()
  assert.equal(summary.usage_bridge.configured, true)
  assert.equal(summary.usage_bridge.last_event_at, new Date(now).toISOString())
  assert.equal(summary.accounts[0].automation.last_usage_at, lastSuccess)
  assert.equal(summary.accounts[0].automation.successful_since_check, 1)
  assert.equal(summary.accounts[0].automation.remaining_requests, 99)
})

test('restarted integration does not recount or replay an already accepted VM2 event', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'es2-trace-automation-'))
  const filename = path.join(directory, 'integration.sqlite')
  const first = await setup(t, { filename })
  first.trace.configureGlobal({ every_requests: 1 })
  const original = await first.trace.recordUsage(event('persisted-success'))
  await first.trace.wait(original.id)
  await first.close()
  const store = new Store({ filename, encryptionKey })
  let calls = 0
  const pool = new AccountPool({ store, lifecycle: {} })
  const trace = new ModelTrace({ store, accountPool: pool, usageBridgeConfigured: true, runner: async () => { calls++; return { text: 'unexpected' } } })
  try {
    assert.equal(await trace.recordUsage(event('persisted-success')), null)
    assert.equal(store.getAccount(accountId).successful_requests, 1)
    assert.equal(store.accountModelUsage(accountId)[0].requests, 1)
    assert.equal(store.listRuns({}).total, 1)
    assert.equal(calls, 0)
    await assert.rejects(trace.recordUsage(event('persisted-success', { success: false })), { code: 'usage_event_conflict' })
  } finally {
    await trace.close(); store.close()
    // Only this test's freshly allocated temporary directory is removed.
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('concurrent usage triggers one three-sample run and merges traffic arriving during that run', async t => {
  let releaseFirst
  const firstResponse = new Promise(resolve => { releaseFirst = resolve })
  t.after(() => releaseFirst())
  let calls = 0
  const { trace, store, account } = await setup(t, { runner: async ({ challenge }) => {
    if (++calls === 1) await firstResponse
    return outputFor(challenge)
  } })
  await trace.recordUsage(event('concurrent-1'))
  const run = await trace.recordUsage(event('concurrent-2'))
  assert.equal(trace.summary().accounts[0].automation.active_run_id, run.id)
  await Promise.all(Array.from({ length: 20 }, (_, n) => trace.recordUsage(event(`burst-${n}`))))
  assert.equal(store.listRuns({}).total, 1)
  assert.equal(calls, 1)
  assert.equal(account().successful_requests, 22)
  releaseFirst()
  const completed = await trace.wait(run.id)
  assert.equal(completed.status, 'match')
  assert.equal(calls, 3)
  assert.equal(trace.summary().accounts[0].automation.active_run_id, null)
  assert.equal(trace.summary().accounts[0].automation.successful_since_check, 0)
  trace.tick()
  assert.equal(store.listRuns({}).total, 1)
  assert.equal(await trace.recordUsage(event('after-finish-1')), null)
  const next = await trace.recordUsage(event('after-finish-2'))
  assert.notEqual(next.id, run.id)
  await trace.wait(next.id)
  assert.equal(calls, 6)
})

test('a long automatic interval run schedules its next interval after completion', async t => {
  let now = Date.parse('2026-10-31T08:00:00Z')
  let calls = 0
  const { trace, store, account } = await setup(t, { clock: () => now, runner: async ({ challenge }) => {
    calls++; now += 50_000; return outputFor(challenge)
  } })
  trace.configureGlobal({ trigger: 'interval', interval_seconds: 60 })
  now += 60_000
  trace.tick()
  const runId = trace.summary().accounts[0].automation.active_run_id
  assert.ok(runId)
  const run = await trace.wait(runId)
  assert.equal(run.duration_ms, 150_000)
  assert.equal(account().modeltrace.state.next_due, now + 60_000)
  trace.tick()
  now += 59_999
  trace.tick()
  assert.equal(store.listRuns({}).total, 1)
  assert.equal(calls, 3)
  now++
  trace.tick()
  const secondId = trace.summary().accounts[0].automation.active_run_id
  assert.notEqual(secondId, runId)
  await trace.wait(secondId)
  assert.equal(calls, 6)
})

test('global strategy updates respect account interval overrides and the global off switch', async t => {
  let now = Date.parse('2026-10-31T08:00:00Z')
  const { trace, account } = await setup(t, { clock: () => now })
  trace.configureAccount(accountId, { trigger: 'interval', interval_seconds: 120 })
  now += 10_000
  trace.configureGlobal({ trigger: 'requests', interval_seconds: 600, every_requests: 50 })
  assert.equal(account().modeltrace.state.next_due, now + 120_000)
  assert.equal(trace.summary().accounts[0].automation.trigger, 'interval')
  assert.equal(trace.summary().accounts[0].automation.remaining_requests, null)
  trace.configureGlobal({ enabled: false })
  assert.equal(account().modeltrace.state.next_due, null)
  assert.equal(trace.summary().accounts[0].automation.ready, false)
  assert.ok(trace.summary().accounts[0].automation.blocked_reasons.includes('auto_disabled'))
  trace.configureGlobal({ enabled: true })
  assert.equal(account().modeltrace.state.next_due, now + 120_000)
})

test('disabled, unschedulable and unready accounts record traffic without sampling', async t => {
  let calls = 0
  const { trace, store } = await setup(t, { runner: async ({ challenge }) => { calls++; return outputFor(challenge) } })
  trace.configureGlobal({ every_requests: 1 })
  trace.configureAccount(accountId, { enabled: false })
  assert.equal(await trace.recordUsage(event('disabled')), null)
  assert.ok(trace.summary().accounts[0].automation.blocked_reasons.includes('auto_disabled'))
  trace.configureAccount(accountId, { enabled: true })
  store.updateAccount(accountId, { schedulable: false })
  assert.equal(await trace.recordUsage(event('unschedulable')), null)
  assert.ok(trace.summary().accounts[0].automation.blocked_reasons.includes('account_unschedulable'))
  store.updateAccount(accountId, { schedulable: true, slot_json: { status: 'running', ready: false } })
  assert.equal(await trace.recordUsage(event('unready')), null)
  assert.ok(trace.summary().accounts[0].automation.blocked_reasons.includes('slot_not_ready'))
  assert.equal(store.getAccount(accountId).successful_requests, 3)
  assert.equal(calls, 0)
  assert.equal(store.listRuns({}).total, 0)
})

test('HTTP authenticated usage ingestion triggers exactly one background run and exposes its progress', async t => {
  const { trace, store, pool } = await setup(t)
  const server = createIntegrationServer({ store, accountPool: pool, modeltrace: trace, managementToken: 'test-usage-bridge-secret' })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}/api/v1/admin`
  const headers = { authorization: 'Bearer test-usage-bridge-secret', 'content-type': 'application/json' }
  const post = (body, requestHeaders = headers) => fetch(`${base}/usage/success`, { method: 'POST', headers: requestHeaders, body: JSON.stringify(body) })
  const rejected = await post(event('http-denied'), { 'content-type': 'application/json' })
  assert.equal(rejected.status, 401)
  assert.equal(store.getAccount(accountId).successful_requests, 0)
  const first = await post(event('http-1'))
  assert.equal(first.status, 200)
  assert.equal((await first.json()).data.trace_run, null)
  const second = await post(event('http-2'))
  assert.equal(second.status, 200)
  const run = (await second.json()).data.trace_run
  assert.equal(run.reason, 'requests')
  const completed = await trace.wait(run.id)
  assert.equal(completed.status, 'match')
  assert.equal(completed.samples.length, 3)
  assert.ok(completed.samples.every(sample => sample.sha256.length === 64 && !('text' in sample)))
  const repeated = await post(event('http-2'))
  assert.equal((await repeated.json()).data.trace_run, null)
  const conflicting = await post(event('http-2', { upstream_model: 'model-b' }))
  assert.equal(conflicting.status, 409)
  assert.equal((await conflicting.json()).error.code, 'usage_event_conflict')
  const summary = (await (await fetch(`${base}/modeltrace/summary`, { headers })).json()).data
  assert.equal(summary.active_runs, 0)
  assert.equal(summary.run_counts.match, 1)
  assert.equal(summary.accounts[0].automation.successful_since_check, 0)
  assert.equal(summary.accounts[0].automation.remaining_requests, 2)
  assert.equal(summary.accounts[0].automation.ready, true)
  const detail = (await (await fetch(`${base}/accounts/${accountId}/modeltrace`, { headers })).json()).data
  assert.deepEqual(detail.automation, summary.accounts[0].automation)
  assert.equal(JSON.stringify(summary).includes('synthetic-test-token'), false)
  assert.equal(JSON.stringify(summary).includes('test-usage-bridge-secret'), false)
})
