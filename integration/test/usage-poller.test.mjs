import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../src/store.mjs'
import { AccountPool } from '../src/account-pool.mjs'
import { ModelTrace } from '../src/modeltrace.mjs'
import { createUsagePoller } from '../src/usage-poller.mjs'

const event = (event_id, vm_id = 'poller-vm') => ({ event_id, vm_id, model: 'model-a', upstream_model: 'model-a', success: true })
const reporter = { enabled: true, mode: 'pull', pending: 1, accepted: 2, delivered: 1, failed: 0, dropped: 0, skipped: { internal: 3 }, private_debug: 'must-not-persist' }
const outbox = items => ({ ok: true, items, reporter })
const fixture = {
  challenges: [1, 2, 3].map(n => ({ id: `p${n}`, prompt: `Synthetic challenge ${n}` })),
  models: ['model-a', 'model-b'].map(id => ({ id, responses: [1, 2, 3].map(n => ({ challenge_id: `p${n}`, text: `${id} synthetic answer ${n}` })) })),
}

async function setup(t) {
  let samples = 0
  const store = new Store({ encryptionKey: 'ad'.repeat(32) })
  const pool = new AccountPool({ store, lifecycle: {
    async provision() { return { vm_id: 'poller-vm', slot: { status: 'running', ready: true } } },
    async remove() {},
  } })
  pool.createGroup({ id: 'poller-group', name: 'Poller fixture' })
  await pool.importAccount({ account_id: 'poller-account', group_ids: ['poller-group'], credential: { access_token: 'synthetic-poller-token' } })
  const modeltrace = new ModelTrace({ store, accountPool: pool, usageBridgeConfigured: true,
    runner: async ({ challenge }) => {
      samples++
      return { text: fixture.models[0].responses.find(row => row.challenge_id === challenge.id).text }
    },
  })
  modeltrace.installBank(fixture)
  modeltrace.configureGlobal({ model: 'model-a', every_requests: 1 })
  t.after(async () => { await modeltrace.close(); store.close() })
  return { store, modeltrace, samples: () => samples }
}

test('lost acknowledgement and redelivery never recount usage or replay its three inference samples', async t => {
  const { store, modeltrace, samples } = await setup(t)
  let now = Date.parse('2026-10-31T08:00:00Z')
  let acknowledgements = 0
  let pending = [event('ack-lost-event')]
  const paths = []
  const vm2 = {
    async ensureSession() {},
    async request(path, options) {
      paths.push(path)
      if (path.endsWith('/ack')) {
        assert.equal(options.method, 'POST')
        assert.deepEqual(options.body, { event_ids: ['ack-lost-event'] })
        if (++acknowledgements === 1) throw new Error('private upstream error: lost ack response')
        pending = []
        return { ok: true }
      }
      return outbox(pending)
    },
  }
  const poller = createUsagePoller({ vm2, store, modeltrace, clock: () => now })
  assert.deepEqual(await poller.poll(), { delivered: 0, error: 'usage_delivery_unavailable' })
  const run = store.listRuns({}).items[0]
  assert.ok(run)
  await modeltrace.wait(run.id)
  assert.equal(samples(), 3)
  assert.equal(store.getAccount('poller-account').successful_requests, 1)
  assert.equal(await poller.poll(), null)
  now += 5000
  assert.deepEqual(await poller.poll(), { delivered: 1 })
  assert.equal(store.getAccount('poller-account').successful_requests, 1)
  assert.equal(store.accountModelUsage('poller-account')[0].requests, 1)
  assert.equal(store.listRuns({}).total, 1)
  assert.equal(samples(), 3)
  assert.deepEqual(await poller.poll(), { delivered: 0 })
  assert.equal(acknowledgements, 2)
  assert.ok(paths.every(path => path.startsWith('/api/panel/integration/usage-events')))
  assert.equal(store.getSetting('modeltrace_usage_bridge_poll').last_error, null)
  assert.deepEqual(store.getSetting('modeltrace_usage_bridge_poll').reporter,
    { pending: 1, accepted: 2, delivered: 1, failed: 0, dropped: 0, skipped: { internal: 3 } })
  assert.equal(JSON.stringify(store.getSetting('modeltrace_usage_bridge_poll')).includes('must-not-persist'), false)
  await poller.close()
})

test('concurrent polls share one control request and close waits for it without accepting new work', async () => {
  const settings = new Map()
  let release
  const gate = new Promise(resolve => { release = resolve })
  let sessionCalls = 0
  let reads = 0
  const poller = createUsagePoller({
    vm2: { async ensureSession() { sessionCalls++; await gate }, async request() { reads++; return outbox([]) } },
    modeltrace: { async recordUsage() { assert.fail('empty outbox must not record usage') } },
    store: { setSetting: (key, value) => settings.set(key, value) },
  })
  const first = poller.poll()
  const second = poller.poll()
  assert.equal(first, second)
  assert.equal(sessionCalls, 1)
  let closed = false
  const closing = poller.close().then(() => { closed = true })
  await Promise.resolve()
  assert.equal(closed, false)
  assert.equal(await poller.poll(), null)
  release()
  assert.deepEqual(await first, { delivered: 0 })
  await closing
  assert.equal(closed, true)
  assert.equal(reads, 1)
  assert.equal(await poller.poll(), null)
  assert.equal(settings.get('modeltrace_usage_bridge_poll').last_error, null)
})

test('control channel failures back off for five seconds and expose only a safe error', async () => {
  let now = Date.parse('2026-10-31T08:00:00Z')
  let sessions = 0
  const settings = new Map()
  const poller = createUsagePoller({ clock: () => now,
    vm2: {
      async ensureSession() { if (++sessions === 1) throw new Error('Bearer private-session-token') },
      async request() { return outbox([]) },
    },
    modeltrace: { async recordUsage() { assert.fail('empty outbox must not record usage') } },
    store: { setSetting: (key, value) => settings.set(key, value) },
  })
  assert.deepEqual(await poller.poll(), { delivered: 0, error: 'usage_delivery_unavailable' })
  assert.equal(settings.get('modeltrace_usage_bridge_poll').last_error, 'usage_delivery_unavailable')
  now += 4999
  assert.equal(await poller.poll(), null)
  assert.equal(sessions, 1)
  now++
  assert.deepEqual(await poller.poll(), { delivered: 0 })
  assert.equal(sessions, 2)
  assert.equal(settings.get('modeltrace_usage_bridge_poll').last_error, null)
  assert.equal(JSON.stringify([...settings]).includes('private-session-token'), false)
  await poller.close()
})

test('events belonging to unowned VM2 slots are acknowledged without changing managed account counters', async t => {
  const { store, modeltrace, samples } = await setup(t)
  modeltrace.configureGlobal({ every_requests: 100 })
  const acks = []
  const poller = createUsagePoller({ store, modeltrace, vm2: {
    async ensureSession() {},
    async request(path, options) {
      if (path.endsWith('/ack')) { acks.push(options.body); return { ok: true } }
      return outbox([event('external-1', 'unrelated-vm'), event('owned-1')])
    },
  } })
  assert.deepEqual(await poller.poll(), { delivered: 2 })
  assert.deepEqual(acks, [{ event_ids: ['external-1', 'owned-1'] }])
  assert.equal(store.getAccount('poller-account').successful_requests, 1)
  assert.equal(store.listRuns({}).total, 0)
  assert.equal(samples(), 0)
  await poller.close()
})

test('invalid outbox shape is rejected before processing or acknowledging any event', async () => {
  for (const pending of [{ ...outbox([]), ok: false }, outbox({}), outbox(Array(101).fill(event('overflow')))]) {
    let requests = 0
    const poller = createUsagePoller({
      vm2: { async ensureSession() {}, async request() { requests++; return pending } },
      modeltrace: { async recordUsage() { assert.fail('invalid batch must not be consumed') } },
      store: { setSetting() {} },
    })
    assert.deepEqual(await poller.poll(), { delivered: 0, error: 'usage_delivery_unavailable' })
    assert.equal(requests, 1)
    await poller.close()
  }
})

test('absent, disabled or wrong-mode reporter never reports a healthy pull bridge or acknowledges events', async () => {
  for (const invalidReporter of [undefined, { enabled: false, mode: 'pull' }, { enabled: true, mode: 'push' }]) {
    const calls = []
    const settings = new Map()
    const poller = createUsagePoller({
      vm2: { async ensureSession() {}, async request(path) {
        calls.push(path)
        return { ok: true, items: [event('not-active')], reporter: invalidReporter }
      } },
      modeltrace: { async recordUsage() { assert.fail('inactive reporter must not contribute usage') } },
      store: { setSetting: (key, value) => settings.set(key, value) },
    })
    assert.deepEqual(await poller.poll(), { delivered: 0, error: 'usage_delivery_unavailable' })
    assert.deepEqual(calls, ['/api/panel/integration/usage-events'])
    assert.equal(settings.get('modeltrace_usage_bridge_poll').last_error, 'usage_delivery_unavailable')
    await poller.close()
  }
})
