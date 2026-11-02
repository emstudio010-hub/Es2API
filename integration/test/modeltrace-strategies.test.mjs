import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Store } from '../src/store.mjs'
import { AccountPool } from '../src/account-pool.mjs'
import { ModelTrace } from '../src/modeltrace.mjs'
import { traceDefaults, validateTraceConfig } from '../src/modeltrace-config.mjs'

const key = 'ba'.repeat(32)
const accountId = 'strategies-account'
const vmId = 'strategies-vm'
const epoch = Date.parse('2026-10-31T08:00:00Z')
const timerModes = ['interval', 'both', 'requests_and_interval', 'active_interval']
const automaticModes = ['requests', ...timerModes, 'probability', 'idle_return']
const fixture = {
  challenges: [1, 2, 3].map(n => ({ id: `s${n}`, prompt: `Synthetic challenge ${n}` })),
  models: ['model-a', 'model-b'].map(id => ({ id, responses: [1, 2, 3].map(n => ({ challenge_id: `s${n}`, text: `${id} synthetic reference ${n}` })) })),
}
const sample = challenge => ({ text: fixture.models[0].responses.find(row => row.challenge_id === challenge.id).text })

async function setup(t, { trigger = 'requests', config = {}, runner, random = () => 0, triggerRandom = () => 0, filename = ':memory:' } = {}) {
  let now = epoch
  let eventNumber = 0
  let calls = 0
  const store = new Store({ filename, encryptionKey: key })
  const pool = new AccountPool({ store, lifecycle: {
    async provision() { return { vm_id: vmId, slot: { status: 'running', ready: true } } },
    async remove() {},
  } })
  pool.createGroup({ id: 'strategies-group', name: 'Strategy fixture' })
  await pool.importAccount({ account_id: accountId, group_ids: ['strategies-group'], credential: { access_token: 'synthetic-strategy-token' } })
  const trace = new ModelTrace({ store, accountPool: pool, usageBridgeConfigured: true,
    clock: () => now, random, triggerRandom,
    runner: async args => { calls++; return runner ? runner(args, calls) : sample(args.challenge) },
  })
  trace.installBank(fixture)
  trace.configureGlobal({ model: 'model-a', trigger, every_requests: 2, interval_seconds: 60, ...config })
  let closed = false
  const close = async () => { if (!closed) { closed = true; await trace.close(); store.close() } }
  t.after(close)
  return {
    store, pool, trace, close,
    now: () => now, set: value => { now = value }, advance: ms => { now += ms }, calls: () => calls,
    account: () => store.getAccount(accountId), total: () => store.listRuns({ account_id: accountId }).total,
    active: () => trace.summary().accounts.find(row => row.account_id === accountId)?.automation.active_run_id,
    usage: (overrides = {}) => trace.recordUsage({ source: 'vm2', event_id: `strategy-event-${++eventNumber}`, vm_id: vmId,
      model: 'model-a', upstream_model: 'model-a', success: true, ...overrides }),
  }
}

test('old persisted configurations retain defaults and new strategy fields are strictly validated', () => {
  const old = { enabled: true, trigger: 'requests', model: 'model-a', every_requests: 10 }
  const config = validateTraceConfig(old)
  assert.equal(config.sampling_probability, 0.1)
  assert.equal(config.idle_seconds, 1800)
  assert.equal(config.cooldown_seconds, 0)
  assert.deepEqual(validateTraceConfig({ trigger: 'probability' }, { partial: true }), { trigger: 'probability' })
  for (const trigger of [...automaticModes, 'manual']) assert.equal(validateTraceConfig({ trigger }).trigger, trigger)
  for (const sampling_probability of [0, 0.009, 1.001, NaN, Infinity, '0.1']) {
    assert.throws(() => validateTraceConfig({ sampling_probability }), { code: 'invalid_trace_config' })
  }
  for (const idle_seconds of [59, 604801, 60.5, '60']) assert.throws(() => validateTraceConfig({ idle_seconds }), { code: 'invalid_trace_config' })
  for (const cooldown_seconds of [-1, 604801, 0.5, '60']) assert.throws(() => validateTraceConfig({ cooldown_seconds }), { code: 'invalid_trace_config' })
  assert.equal(validateTraceConfig({ sampling_probability: 0.01, idle_seconds: 60, cooldown_seconds: 604800 }).sampling_probability, 0.01)
  assert.equal(validateTraceConfig({ sampling_probability: 1, idle_seconds: 604800, cooldown_seconds: 0 }).sampling_probability, 1)
  assert.throws(() => validateTraceConfig({ trigger: 'any' }), { code: 'invalid_trace_config' })
  assert.throws(() => validateTraceConfig({ sample_probability: 0.2 }), { code: 'invalid_trace_config' })
})

test('requests count only successful calls while interval and OR can sample without traffic', async t => {
  const requests = await setup(t, { trigger: 'requests' })
  requests.advance(120_000)
  requests.trace.tick()
  assert.equal(requests.total(), 0)
  assert.equal(await requests.usage({ success: false }), null)
  assert.equal(await requests.usage(), null)
  const threshold = await requests.usage()
  assert.equal(threshold.reason, 'requests')
  await requests.trace.wait(threshold.id)
  for (const trigger of ['interval', 'both']) {
    const context = await setup(t, { trigger })
    context.advance(59_999); context.trace.tick()
    assert.equal(context.total(), 0)
    context.advance(1); context.trace.tick()
    const run = await context.trace.wait(context.active())
    assert.equal(run.reason, 'interval')
    assert.equal(run.samples.length, 3)
  }
  const or = await setup(t, { trigger: 'both' })
  await or.usage()
  const early = await or.usage()
  assert.equal(early.reason, 'requests')
  assert.equal(or.now(), epoch)
  await or.trace.wait(early.id)
})

test('AND waits for both count and time whichever condition becomes true first', async t => {
  const countFirst = await setup(t, { trigger: 'requests_and_interval' })
  assert.equal(await countFirst.usage(), null)
  assert.equal(await countFirst.usage(), null)
  countFirst.advance(59_999); countFirst.trace.tick()
  assert.equal(countFirst.total(), 0)
  countFirst.advance(1); countFirst.trace.tick()
  const first = await countFirst.trace.wait(countFirst.active())
  assert.equal(first.reason, 'requests_and_interval')
  assert.equal(first.status, 'match')
  const timeFirst = await setup(t, { trigger: 'requests_and_interval' })
  timeFirst.advance(60_000); timeFirst.trace.tick()
  assert.equal(timeFirst.total(), 0)
  assert.equal(await timeFirst.usage(), null)
  const second = await timeFirst.usage()
  assert.equal(second.reason, 'requests_and_interval')
  await timeFirst.trace.wait(second.id)
})

test('active interval requires fresh success and timer initialization preserves accumulated successes', async t => {
  const context = await setup(t, { trigger: 'active_interval' })
  context.advance(180_000); context.trace.tick()
  assert.equal(context.total(), 0)
  assert.equal(await context.usage({ success: false }), null)
  context.trace.tick()
  assert.equal(context.total(), 0)
  const run = await context.usage()
  assert.ok(run)
  assert.equal(run.reason, 'active_interval')
  await context.trace.wait(run.id)
  context.advance(60_000); context.trace.tick()
  assert.equal(context.total(), 1)
  for (const trigger of ['active_interval', 'requests_and_interval']) {
    const startup = await setup(t, { trigger, config: { every_requests: 1 } })
    startup.store.updateAccount(accountId, { modeltrace_state: { checkpoint: 0 }, successful_requests: 1 })
    startup.trace.tick()
    assert.equal(startup.account().modeltrace.state.checkpoint, 0)
    assert.equal(startup.account().modeltrace.state.next_due, epoch + 60_000)
    startup.advance(60_000); startup.trace.tick()
    const initialized = await startup.trace.wait(startup.active())
    assert.equal(initialized.samples.length, 3)
  }
})

test('probability draws once per eligible unique success and uses an independent random stream', async t => {
  let draws = 0
  let sampleDraws = 0
  let release
  const gate = new Promise(resolve => { release = resolve })
  t.after(() => release())
  const context = await setup(t, { trigger: 'probability', config: { sampling_probability: 0.5 },
    triggerRandom: () => ++draws === 1 ? 0.5 : 0.499999,
    random: () => { sampleDraws++; return 0 },
    runner: async ({ challenge }, calls) => { if (calls === 1) await gate; return sample(challenge) },
  })
  assert.equal(await context.usage({ event_id: 'probability-equal' }), null)
  assert.equal(draws, 1)
  await context.usage({ event_id: 'probability-equal' })
  await context.usage({ success: false })
  context.advance(180_000); context.trace.tick(); context.trace.tick()
  assert.equal(draws, 1)
  context.trace.configureAccount(accountId, { enabled: false })
  await context.usage()
  context.trace.configureAccount(accountId, { enabled: true })
  context.store.updateAccount(accountId, { slot_json: { ready: false, status: 'running' } })
  await context.usage()
  assert.equal(draws, 1)
  context.store.updateAccount(accountId, { slot_json: { ready: true, status: 'running' } })
  const run = await context.usage()
  assert.equal(run.reason, 'probability')
  assert.equal(draws, 2)
  assert.equal(sampleDraws, 3)
  await Promise.all([context.usage(), context.usage(), context.usage()])
  assert.equal(draws, 2)
  assert.equal(context.total(), 1)
  release(); await context.trace.wait(run.id)
  context.trace.tick()
  assert.equal(draws, 2)
})

test('idle return samples first success and resumed traffic, not failures or the timer', async t => {
  const context = await setup(t, { trigger: 'idle_return', config: { idle_seconds: 60 } })
  const initial = await context.usage()
  assert.equal(initial.reason, 'idle_return')
  await context.trace.wait(initial.id)
  context.advance(59_999)
  assert.equal(await context.usage(), null)
  context.advance(59_999)
  assert.equal(await context.usage({ success: false }), null)
  context.advance(1)
  context.trace.tick()
  assert.equal(context.total(), 1)
  const resumed = await context.usage()
  assert.equal(resumed.reason, 'idle_return')
  await context.trace.wait(resumed.id)
  const duplicate = await context.usage({ event_id: 'repeat-resume' })
  assert.equal(duplicate, null)
  context.advance(120_000)
  assert.equal(await context.usage({ event_id: 'repeat-resume' }), null)
  assert.equal(context.total(), 2)
})

test('all automatic strategies respect cooldown; manual bypasses and resets the cooldown base', async t => {
  for (const trigger of automaticModes) await t.test(trigger, async sub => {
    let draws = 0
    const context = await setup(sub, { config: { cooldown_seconds: 120 }, triggerRandom: () => { draws++; return 0 } })
    const initial = context.trace.run(accountId)
    await context.trace.wait(initial.id)
    context.trace.configureGlobal({ trigger, every_requests: 1, interval_seconds: 60, idle_seconds: 60, sampling_probability: 1 })
    context.advance(60_000)
    assert.equal(await context.usage(), null)
    context.trace.tick()
    assert.equal(context.total(), 1)
    assert.equal(draws, 0)
    context.advance(59_999); context.trace.tick()
    assert.equal(context.total(), 1)
    context.advance(1)
    let automatic
    if (timerModes.includes(trigger)) { context.trace.tick(); automatic = context.active() }
    else { context.trace.tick(); assert.equal(context.total(), 1); automatic = (await context.usage())?.id }
    assert.ok(automatic, `${trigger} must become eligible at cooldown boundary`)
    await context.trace.wait(automatic)
    const manual = context.trace.run(accountId)
    await context.trace.wait(manual.id)
    assert.equal(context.total(), 3)
    assert.equal(context.account().modeltrace.state.last_finished_at, context.now())
    assert.equal(await context.usage(), null)
    assert.equal(context.total(), 3)
  })
})

test('error and canceled runs start cooldown without automatic replay', async t => {
  for (const terminal of ['error', 'canceled']) await t.test(terminal, async sub => {
    let release
    const gate = new Promise(resolve => { release = resolve })
    sub.after(() => release())
    const context = await setup(sub, { config: { every_requests: 1, cooldown_seconds: 60 }, runner: async () => {
      await gate
      if (terminal === 'error') throw Object.assign(new Error('fixture failure'), { code: 'fixture_failure' })
      return { text: 'canceled fixture output' }
    } })
    const run = await context.usage()
    context.advance(120_000)
    if (terminal === 'canceled') context.trace.cancel(accountId)
    release()
    const saved = await context.trace.wait(run.id)
    assert.equal(saved.status, terminal)
    assert.equal(context.account().modeltrace.state.last_finished_at, context.now())
    assert.equal(await context.usage(), null)
    context.advance(59_999)
    assert.equal(await context.usage(), null)
    assert.equal(context.total(), 1)
    context.advance(1)
    const next = await context.usage()
    assert.ok(next)
    await context.trace.wait(next.id)
    assert.equal(context.total(), 2)
  })
})

test('manual strategy never samples automatically even when every other condition is satisfied', async t => {
  let draws = 0
  const context = await setup(t, { trigger: 'manual', config: { every_requests: 1, cooldown_seconds: 60, sampling_probability: 1 },
    triggerRandom: () => { draws++; return 0 },
  })
  await context.usage(); context.advance(600_000); await context.usage(); context.trace.tick()
  assert.equal(context.total(), 0)
  assert.equal(draws, 0)
  const one = context.trace.run(accountId); await context.trace.wait(one.id)
  const two = context.trace.run(accountId); await context.trace.wait(two.id)
  assert.equal(context.total(), 2)
  assert.equal(draws, 0)
})

test('long runs coalesce in-flight usage and restart time and cooldown from their finish', async t => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  t.after(() => release())
  const context = await setup(t, { trigger: 'requests_and_interval', config: { every_requests: 1, cooldown_seconds: 120 },
    runner: async ({ challenge }, calls) => { if (calls === 1) await gate; return sample(challenge) },
  })
  await context.usage(); context.advance(60_000); context.trace.tick()
  const id = context.active()
  context.advance(300_000)
  await Promise.all(Array.from({ length: 5 }, () => context.usage()))
  context.trace.tick()
  assert.equal(context.total(), 1)
  release(); await context.trace.wait(id)
  assert.equal(context.account().modeltrace.state.checkpoint, context.account().successful_requests)
  assert.equal(context.account().modeltrace.state.next_due, context.now() + 60_000)
  assert.equal(context.account().modeltrace.state.last_finished_at, context.now())
  context.advance(60_000); await context.usage(); context.trace.tick()
  assert.equal(context.total(), 1)
  context.advance(60_000); context.trace.tick()
  await context.trace.wait(context.active())
  assert.equal(context.total(), 2)
})

test('restart preserves due and cooldown and old history supplies the legacy finish timestamp', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'es2-strategy-state-'))
  const filename = path.join(directory, 'trace.sqlite')
  const context = await setup(t, { filename, trigger: 'interval', config: { cooldown_seconds: 120 } })
  const run = context.trace.run(accountId)
  await context.trace.wait(run.id)
  const state = { ...context.account().modeltrace.state }
  delete state.last_finished_at
  context.store.updateAccount(accountId, { modeltrace_state: state })
  await context.close()
  let now = epoch + 60_000
  let calls = 0
  const store = new Store({ filename, encryptionKey: key })
  const pool = new AccountPool({ store, lifecycle: {} })
  const trace = new ModelTrace({ store, accountPool: pool, usageBridgeConfigured: true, clock: () => now,
    runner: async ({ challenge }) => { calls++; return sample(challenge) },
  })
  try {
    assert.equal(store.getAccount(accountId).modeltrace.state.next_due, epoch + 60_000)
    trace.tick()
    assert.equal(calls, 0)
    assert.equal(store.listRuns({}).total, 1)
    now += 60_000
    trace.tick()
    const active = trace.summary().accounts[0].automation.active_run_id
    assert.ok(active)
    await trace.wait(active)
    assert.equal(calls, 3)
    assert.equal(store.listRuns({}).total, 2)
    assert.equal(store.getAccount(accountId).modeltrace.state.next_due, now + 60_000)
  } finally { await trace.close(); store.close(); fs.rmSync(directory, { recursive: true, force: true }) }
})

test('policy saves reset progress but cannot erase the most recent completion cooldown', async t => {
  const context = await setup(t, { config: { cooldown_seconds: 120 } })
  const manual = context.trace.run(accountId)
  await context.trace.wait(manual.id)
  const finished = context.account().modeltrace.state.last_finished_at
  context.advance(30_000)
  await context.usage()
  context.trace.configureAccount(accountId, { trigger: 'requests_and_interval', every_requests: 1, interval_seconds: 60 })
  assert.equal(context.account().modeltrace.state.checkpoint, context.account().successful_requests)
  assert.equal(context.account().modeltrace.state.last_finished_at, finished)
  assert.equal(context.account().modeltrace.state.next_due, context.now() + 60_000)
  context.trace.configureGlobal({ trigger: 'manual', cooldown_seconds: 120 })
  assert.equal(context.trace.getAccountConfig(context.account()).trigger, 'requests_and_interval')
  assert.equal(context.account().modeltrace.state.last_finished_at, finished)
  await context.usage()
  context.advance(60_000); context.trace.tick()
  assert.equal(context.total(), 1)
  context.advance(30_000); context.trace.tick()
  await context.trace.wait(context.active())
  assert.equal(context.total(), 2)
})

test('legacy settings without new keys load through ModelTrace with stable defaults', async t => {
  const context = await setup(t)
  const legacy = { ...traceDefaults, model: 'model-a' }
  delete legacy.sampling_probability
  delete legacy.idle_seconds
  delete legacy.cooldown_seconds
  context.store.setSetting('modeltrace_config', legacy)
  assert.equal(context.trace.getGlobalConfig().sampling_probability, 0.1)
  assert.equal(context.trace.getAccountConfig(context.account()).idle_seconds, 1800)
  assert.equal(context.trace.getAccountConfig(context.account()).cooldown_seconds, 0)
})
