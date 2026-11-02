import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Store } from '../src/store.mjs'
import { AccountPool } from '../src/account-pool.mjs'

const ENCRYPTION_KEY = '12'.repeat(32)

function createPool({ lifecycle, beforeRemoveAccount } = {}) {
  const store = new Store({ filename: ':memory:', encryptionKey: ENCRYPTION_KEY })
  const calls = []
  const service = lifecycle || {
    async provision(binding, credentialValue, options) {
      calls.push(['provision', binding, options])
      return { vm_id: `vm-${binding.account_id}`, slot: { id: `vm-${binding.account_id}`, ready: true } }
    },
    async remove(binding, vmId) { calls.push(['remove', binding, vmId]); return { phase: 'deleted' } },
  }
  return { store, calls, pool: new AccountPool({ store, lifecycle: service, beforeRemoveAccount }) }
}

const credential = suffix => ({ access_token: `access-token-secret-${suffix}`, refresh_token: `refresh-secret-${suffix}` })

test('pool import stores encrypted credentials and enables scheduling only after slot readiness', async t => {
  const { store, pool } = createPool()
  t.after(() => store.close())
  const group = pool.createGroup({ id: 'pool-a', name: 'Primary' })
  const account = await pool.importAccount({ account_id: 'account-a', group_ids: [group.id], credential: credential('a') })

  assert.equal(account.status, 'ready')
  assert.equal(account.schedulable, true)
  assert.equal(account.slot.ready, true)
  assert.equal(account.modeltrace.overrides.enabled, true)
  assert.equal(JSON.stringify(account).includes('access-token-secret-a'), false)
  assert.equal(JSON.stringify(account).includes('refresh-secret-a'), false)
  assert.deepEqual(store.getCredential(account.id), {
    access_token: 'access-token-secret-a',
    refresh_token: 'refresh-secret-a',
    id_token: null,
    api_key: null,
  })
  assert.equal(store.db.prepare('SELECT credential_ciphertext FROM pool_accounts WHERE id=?').get(account.id)
    .credential_ciphertext.includes('access-token-secret-a'), false)
  assert.equal(pool.listGroups()[0].account_count, 1)
})

test('unassigned pool accounts are ready but cannot be enabled for scheduling', async t => {
  const { store, pool } = createPool()
  t.after(() => store.close())
  const account = await pool.importAccount({ account_id: 'unassigned', credential: credential('unassigned') })
  assert.equal(account.status, 'ready')
  assert.equal(account.schedulable, false)
  assert.throws(() => pool.updateAccount(account.id, { schedulable: true }), error => error.code === 'account_not_schedulable')

  const group = pool.createGroup({ id: 'g-ready', name: 'Ready' })
  const updated = pool.updateAccount(account.id, { group_ids: [group.id], schedulable: true })
  assert.equal(updated.schedulable, true)
  assert.deepEqual(updated.group_ids, [group.id])
  const ungrouped = pool.updateAccount(account.id, { group_ids: [] })
  assert.equal(ungrouped.schedulable, false)
  assert.equal(ungrouped.group_ids.length, 0)
})

test('deactivating a group removes its accounts from scheduling without deleting the group binding', async t => {
  const { store, pool } = createPool()
  t.after(() => store.close())
  const group = pool.createGroup({ id: 'inactive-group', name: 'Inactive' })
  const account = await pool.importAccount({ account_id: 'inactive-a', group_ids: [group.id], credential: credential('inactive') })
  assert.equal(account.schedulable, true)
  const updatedGroup = pool.updateGroup(group.id, { status: 'inactive' })
  assert.equal(updatedGroup.status, 'inactive')
  assert.equal(pool.getAccount(account.id).schedulable, false)
  assert.deepEqual(pool.getAccount(account.id).group_ids, [group.id])
  assert.throws(() => pool.updateAccount(account.id, { schedulable: true }), error => error.code === 'account_not_schedulable')
  const reactivated = pool.updateGroup(group.id, { status: 'active' })
  assert.equal(reactivated.status, 'active')
  assert.equal(pool.getAccount(account.id).schedulable, true)
})

test('lease mode creates an isolated group, defaults ModelTrace off and releases ownership after confirmed deletion', async t => {
  const { store, pool, calls } = createPool()
  t.after(() => store.close())
  const account = await pool.importAccount({ account_id: 'lease-a', mode: 'lease', credential: credential('lease-a') })
  const group = store.getGroup(account.group_ids[0])
  assert.equal(group.strategy, 'per_slot')
  assert.equal(group.lease_account_id, account.id)
  assert.equal(account.schedulable, true)
  assert.equal(account.modeltrace.overrides.enabled, false)
  assert.throws(() => pool.deleteGroup(group.id), error => error.code === 'group_in_use')

  await pool.removeAccount(account.id)
  assert.equal(store.getAccount(account.id), null)
  assert.equal(store.getGroup(group.id).lease_account_id, null)
  assert.equal(calls.filter(([kind]) => kind === 'remove').length, 1)
  const replacement = await pool.importAccount({ account_id: 'lease-b', mode: 'lease', group_ids: [group.id], credential: credential('lease-b') })
  assert.equal(replacement.group_ids[0], group.id)
  assert.equal(store.getGroup(group.id).lease_account_id, 'lease-b')
})

test('invalid lease import rolls back its automatically-created group', async t => {
  const { store, pool } = createPool()
  t.after(() => store.close())
  await assert.rejects(() => pool.importAccount({ account_id: 'bad-lease', mode: 'lease', concurrency: 0, credential: credential('bad-lease') }),
    error => error.code === 'invalid_field')
  assert.deepEqual(pool.listGroups(), [])
  assert.deepEqual(pool.listAccounts({}).items, [])
})

test('account inputs match VM2 slot identifiers and scheduling limits before creating local state', async t => {
  const { store, pool, calls } = createPool()
  t.after(() => store.close())
  for (const account_id of ['account.with.dot', 'account-chat']) {
    await assert.rejects(() => pool.importAccount({ account_id, mode: 'lease', credential: credential(account_id) }),
      error => error.status === 400 && error.code === 'invalid_account_id')
  }
  for (const field of [{ concurrency: 257 }, { max_sessions: 257 }, { max_rpm: 1000001 }, { max_sessions: -1 }]) {
    await assert.rejects(() => pool.importAccount({ account_id: 'invalid-limits', mode: 'lease', ...field, credential: credential('invalid-limits') }),
      error => error.status === 400 && error.code === 'invalid_field')
  }
  assert.deepEqual(pool.listAccounts({}).items, [])
  assert.deepEqual(pool.listGroups(), [])
  assert.deepEqual(calls, [])
  const account = await pool.importAccount({ account_id: 'valid-limits', mode: 'lease', concurrency: 256, max_sessions: 256,
    max_rpm: 1000000, credential: credential('valid-limits') })
  assert.equal(calls[0][1].max_concurrency, 256)
  assert.equal(account.concurrency, 256)
  assert.throws(() => pool.updateAccount(account.id, { concurrency: 257 }), error => error.status === 400)
  assert.throws(() => pool.updateAccount(account.id, { max_sessions: 257 }), error => error.status === 400)
  assert.equal(pool.getAccount(account.id).slot_binding_stale, false)
})

test('concurrent imports cannot duplicate one credential or claim a lease group twice', async t => {
  const { store, pool } = createPool()
  t.after(() => store.close())
  const results = await Promise.allSettled([
    pool.importAccount({ account_id: 'race-a', mode: 'lease', credential: credential('same') }),
    pool.importAccount({ account_id: 'race-b', mode: 'lease', credential: credential('same') }),
  ])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(results.filter(result => result.status === 'rejected').length, 1)
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'credential_already_imported')
  const accounts = pool.listAccounts({ page_size: 10 }).items
  assert.equal(accounts.length, 1)
  assert.equal(store.getGroup(accounts[0].group_ids[0]).lease_account_id, accounts[0].id)
})

test('failed provision retains known VM id and binding so retry uses the same account and fixed egress', async t => {
  let attempts = 0
  let retriedBinding
  const generations = []
  const existingVmIds = []
  const lifecycle = {
    async provision(binding, credentialValue, options) {
      attempts++
      generations.push(options.generation)
      existingVmIds.push(options.existingVmId)
      if (attempts === 1) throw Object.assign(new Error('temporary VM2 failure'), { code: 'temporary', vm_id: 'vm-retry' })
      retriedBinding = binding
      return { vm_id: 'vm-retry', slot: { ready: true } }
    },
    async remove() { return { phase: 'deleted' } },
  }
  const { store, pool } = createPool({ lifecycle })
  t.after(() => store.close())
  const group = pool.createGroup({ id: 'retry-group', name: 'Retry' })
  await assert.rejects(() => pool.importAccount({ account_id: 'retry-a', group_ids: [group.id],
    proxy_id: 'proxy-fixed', timezone: 'Europe/Paris', locale: 'fr_FR.UTF-8', max_rpm: 12,
    credential: credential('retry') }), /temporary VM2 failure/)
  const failed = pool.getAccount('retry-a')
  assert.equal(failed.status, 'error')
  assert.equal(failed.vm_id, 'vm-retry')
  assert.equal(failed.schedulable, false)

  const ready = await pool.retryProvision('retry-a')
  assert.equal(ready.status, 'ready')
  assert.equal(ready.schedulable, true)
  assert.equal(retriedBinding.proxy_id, 'proxy-fixed')
  assert.equal(retriedBinding.timezone, 'Europe/Paris')
  assert.equal(retriedBinding.max_rpm, 12)
  assert.equal(attempts, 2)
  assert.deepEqual(generations, [1, 1])
  assert.deepEqual(existingVmIds, [null, 'vm-retry'])
})

test('delete failure preserves a retryable account and waits for trace cancellation hook', async t => {
  const order = []
  let fail = true
  const lifecycle = {
    async provision(binding) { return { vm_id: `vm-${binding.account_id}`, slot: { ready: true } } },
    async remove() {
      order.push('vm-delete')
      if (fail) { fail = false; throw Object.assign(new Error('delete unavailable'), { code: 'vm_down' }) }
    },
  }
  const { store, pool } = createPool({ lifecycle, beforeRemoveAccount: async () => { order.push('trace-cancelled') } })
  t.after(() => store.close())
  const group = pool.createGroup({ id: 'delete-group', name: 'Delete' })
  const account = await pool.importAccount({ account_id: 'delete-a', group_ids: [group.id], credential: credential('delete') })
  await assert.rejects(() => pool.removeAccount(account.id), /delete unavailable/)
  const failed = pool.getAccount(account.id)
  assert.equal(failed.deletion_pending, true)
  assert.equal(failed.status, 'error')
  assert.deepEqual(order, ['trace-cancelled', 'vm-delete'])

  await pool.retryDelete(account.id)
  assert.equal(pool.store.getAccount(account.id), null)
  assert.deepEqual(order, ['trace-cancelled', 'vm-delete', 'trace-cancelled', 'vm-delete'])
})

test('list filters and pagination are bounded and deterministic', async t => {
  const { store, pool } = createPool()
  t.after(() => store.close())
  const group = pool.createGroup({ id: 'page-group', name: 'Page' })
  for (let index = 1; index <= 5; index++) {
    await pool.importAccount({ account_id: `page-${index}`, group_ids: [group.id], credential: credential(`page-${index}`) })
  }
  const page = pool.listAccounts({ group_id: group.id, page: 2, page_size: 2 })
  assert.equal(page.total, 5)
  assert.equal(page.pages, 3)
  assert.equal(page.items.length, 2)
  assert.ok(page.items.every(account => account.group_ids.includes(group.id)))
  assert.equal(pool.listAccounts({ page_size: 1000 }).page_size, 200)
  assert.equal(store.listAllAccounts().length, 5)
})

test('request leases select only ready capacity, are idempotent, and release capacity exactly once', async t => {
  const { store, pool } = createPool()
  t.after(() => store.close())
  const group = pool.createGroup({ id: 'dispatch-group', name: 'Dispatch' })
  const first = await pool.importAccount({ account_id: 'dispatch-a', group_ids: [group.id], concurrency: 1, priority: 10, credential: credential('dispatch-a') })
  const second = await pool.importAccount({ account_id: 'dispatch-b', group_ids: [group.id], concurrency: 1, priority: 20, credential: credential('dispatch-b') })

  const lease = pool.acquireRequest({ request_id: 'req-1', group_ids: [group.id] })
  assert.equal(lease.account.id, first.id)
  assert.equal(lease.account.dispatch.inflight_requests, 1)
  assert.deepEqual(pool.acquireRequest({ request_id: 'req-1', group_ids: [group.id] }).account.id, first.id)
  assert.equal(pool.acquireRequest({ request_id: 'req-2', group_ids: [group.id] }).account.id, second.id)
  assert.throws(() => pool.acquireRequest({ request_id: 'req-2b', group_ids: [group.id] }), error => error.code === 'pool_unavailable')
  const released = pool.releaseRequest('req-1', { success: false, error_code: 'upstream_rate_limit', rate_limited_until: '2999-01-01T00:00:00.000Z' })
  assert.equal(released.released, true)
  assert.equal(pool.releaseRequest('req-1').released, false)
  assert.equal(pool.poolStats({ group_id: group.id }).blocked, 1)
  assert.throws(() => pool.acquireRequest({ request_id: 'req-3', group_ids: [group.id] }), error => error.code === 'pool_unavailable')
  assert.equal(pool.releaseRequest('req-2', { success: true }).released, true)
  assert.equal(pool.acquireRequest({ request_id: 'req-4', group_ids: [group.id] }).account.id, second.id)
})

test('finishing an older parallel request does not clear a longer account cooldown', async t => {
  const { store, pool } = createPool()
  t.after(() => store.close())
  const group = pool.createGroup({ id: 'parallel-group', name: 'Parallel' })
  const account = await pool.importAccount({ account_id: 'parallel-a', group_ids: [group.id], concurrency: 2, credential: credential('parallel') })
  assert.equal(pool.acquireRequest({ request_id: 'parallel-1', group_ids: [group.id] }).account.id, account.id)
  assert.equal(pool.acquireRequest({ request_id: 'parallel-2', group_ids: [group.id] }).account.id, account.id)
  pool.releaseRequest('parallel-1', { rate_limited_until: '2999-01-01T00:00:00.000Z' })
  pool.releaseRequest('parallel-2', { success: true })
  assert.equal(pool.poolStats({ group_id: group.id }).blocked, 1)
  assert.throws(() => pool.acquireRequest({ request_id: 'parallel-3', group_ids: [group.id] }), error => error.code === 'pool_unavailable')
})

test('process restart interrupts active request leases and clears their capacity reservations', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'es2api-dispatch-restart-'))
  const filename = path.join(directory, 'dispatch.sqlite')
  const first = new Store({ filename, encryptionKey: ENCRYPTION_KEY })
  const lifecycle = { async provision(binding) { return { vm_id: `vm-${binding.account_id}`, slot: { ready: true } } }, async remove() {} }
  const pool = new AccountPool({ store: first, lifecycle })
  const group = pool.createGroup({ id: 'restart-group', name: 'Restart' })
  await pool.importAccount({ account_id: 'restart-account', group_ids: [group.id], credential: credential('restart') })
  pool.acquireRequest({ request_id: 'restart-request', group_ids: [group.id] })
  first.close()

  const second = new Store({ filename, encryptionKey: ENCRYPTION_KEY })
  assert.equal(second.db.prepare("SELECT state FROM account_request_leases WHERE request_id='restart-request'").get().state, 'interrupted')
  assert.equal(second.getAccount('restart-account').dispatch.inflight_requests, 0)
  assert.equal(second.releaseRequest('restart-request').reason, 'already_interrupted')
  assert.equal(second.getAccount('restart-account').dispatch.inflight_requests, 0)
  second.close()
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

test('active slot IP is immutable and must be changed by delete and re-import', async t => {
  const { store, pool } = createPool()
  t.after(() => store.close())
  const group = pool.createGroup({ id: 'rebind-group', name: 'Rebind' })
  const account = await pool.importAccount({ account_id: 'rebind-a', group_ids: [group.id], credential: credential('rebind'), proxy_id: 'proxy-a' })
  assert.throws(() => pool.updateAccount(account.id, { proxy_id: 'proxy-b' }), error => error.code === 'slot_ip_immutable')
  assert.throws(() => pool.updateAccount(account.id, { timezone: 'Asia/Tokyo' }), error => error.code === 'slot_ip_immutable')
  assert.equal(pool.getAccount(account.id).binding.proxy_id, 'proxy-a')
})

test('account lifecycle lock rejects binding edits while provisioning is in flight', async t => {
  let beginProvision
  let finishProvision
  const entered = new Promise(resolve => { beginProvision = resolve })
  const gate = new Promise(resolve => { finishProvision = resolve })
  const lifecycle = {
    async provision(binding) {
      beginProvision()
      await gate
      return { vm_id: `vm-${binding.account_id}`, slot: { ready: true, status: 'running' } }
    },
    async remove() {},
  }
  const { store, pool } = createPool({ lifecycle })
  t.after(() => store.close())
  const group = pool.createGroup({ id: 'locked-group', name: 'Locked' })
  const importing = pool.importAccount({ account_id: 'locked-account', group_ids: [group.id], credential: credential('locked') })
  await entered

  assert.throws(() => pool.updateAccount('locked-account', { proxy_id: 'proxy-new' }), error => error.code === 'lifecycle_busy')
  finishProvision()
  const ready = await importing
  assert.equal(ready.status, 'ready')
  assert.equal(ready.slot_binding_stale, false)
  assert.equal(ready.binding.proxy_id, null)
})

test('slot sync updates health without exposing credentials', async t => {
  const { store, pool } = createPool({ lifecycle: {
    async provision(binding) { return { vm_id: `vm-${binding.account_id}`, slot: { ready: true, status: 'running' } } },
    async remove() {},
    async inspect() { return { id: 'vm-sync', ready: true, status: 'running', health: { ok: true } } },
  } })
  t.after(() => store.close())
  const group = pool.createGroup({ id: 'sync-group', name: 'Sync' })
  const account = await pool.importAccount({ account_id: 'sync-a', group_ids: [group.id], credential: credential('sync') })
  const synced = await pool.syncAccount(account.id)
  assert.equal(synced.status, 'ready')
  assert.equal(synced.schedulable, true)
  assert.equal(synced.dispatch.last_health_check_at !== null, true)
  assert.equal(JSON.stringify(synced).includes('access-token-secret-sync'), false)
})

test('slot health failure is not admitted to the scheduling pool', async t => {
  const { store, pool } = createPool({ lifecycle: {
    async provision(binding) { return { vm_id: `vm-${binding.account_id}`, slot: { ready: true, status: 'running' } } },
    async remove() {},
    async inspect() { return { id: 'vm-unhealthy', ready: true, status: 'running', health: { ok: false, code: 'probe_failed' } } },
  } })
  t.after(() => store.close())
  const group = pool.createGroup({ id: 'unhealthy-group', name: 'Unhealthy' })
  const account = await pool.importAccount({ account_id: 'unhealthy-a', group_ids: [group.id], credential: credential('unhealthy') })
  const synced = await pool.syncAccount(account.id)
  assert.equal(synced.status, 'error')
  assert.equal(synced.schedulable, false)
  assert.throws(() => pool.acquireRequest({ request_id: 'unhealthy-request', group_ids: [group.id] }), error => error.code === 'pool_unavailable')
})
