import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../src/store.mjs'
import { AccountPool } from '../src/account-pool.mjs'
import { ModelTrace } from '../src/modeltrace.mjs'
import { createIntegrationServer } from '../src/server.mjs'

const TOKEN = 'management-token-for-tests-0123456789'
const ENCRYPTION_KEY = 'cd'.repeat(32)

function bankFixture() {
  const challenges = [1, 2, 3].map(index => ({ id: `challenge-${index}`, prompt: `Say test phrase ${index}` }))
  const models = ['model-a', 'model-b'].map(model => ({ id: model,
    responses: challenges.map(challenge => ({ challenge_id: challenge.id, text: `${model} response for ${challenge.id}` })) }))
  return { challenges, models }
}

async function createTestServer(t, { lifecycle, runner } = {}) {
  const store = new Store({ filename: ':memory:', encryptionKey: ENCRYPTION_KEY })
  const pool = new AccountPool({ store, lifecycle: lifecycle || {
    async provision(binding) { return { vm_id: `vm-${binding.account_id}`, slot: { ready: true, status: 'running' } } },
    async remove() {},
  } })
  const modeltrace = new ModelTrace({ store, accountPool: pool, runner: runner || (async ({ model, challenge }) => ({ text: `${model} response for ${challenge.id}` })) })
  modeltrace.installBank(bankFixture())
  modeltrace.configureGlobal({ ...modeltrace.getGlobalConfig(), model: 'model-a' })
  const server = createIntegrationServer({ store, accountPool: pool, modeltrace, managementToken: TOKEN })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  t.after(async () => {
    await modeltrace.close()
    await new Promise(resolve => server.close(resolve))
    store.close()
  })
  return { store, pool, modeltrace, base }
}

async function request(base, path, { method = 'GET', token = TOKEN, body, extraHeaders = {} } = {}) {
  const headers = {}
  if (token) headers.authorization = `Bearer ${token}`
  if (body !== undefined) headers['content-type'] = 'application/json'
  Object.assign(headers, extraHeaders)
  const response = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: response.status, headers: response.headers, body: await response.json() }
}

test('health is public; admin APIs reject missing and wrong bearer tokens', async t => {
  const { base } = await createTestServer(t)
  const health = await request(base, '/health', { token: null })
  assert.equal(health.status, 200)
  assert.equal(health.body.data.service, 'es2api-integration')
  assert.equal((await request(base, '/api/v1/admin/accounts', { token: null })).status, 401)
  assert.equal((await request(base, '/api/v1/admin/accounts', { token: 'wrong-token-012345678901234567890' })).status, 401)
})

test('account and group HTTP lifecycle returns only credential metadata and supports retry-safe deletion', async t => {
  const { base, store } = await createTestServer(t)
  const createdGroup = await request(base, '/api/v1/admin/groups', { method: 'POST', body: { id: 'api-group', name: 'API Group' } })
  assert.equal(createdGroup.status, 201)
  const imported = await request(base, '/api/v1/admin/accounts', { method: 'POST', body: {
    account_id: 'api-account', group_ids: ['api-group'], credential: { access_token: 'api-secret-token-value' },
  } })
  assert.equal(imported.status, 201)
  assert.equal(imported.body.data.status, 'ready')
  assert.equal(imported.body.data.schedulable, true)
  assert.equal(JSON.stringify(imported.body).includes('api-secret-token-value'), false)

  const listed = await request(base, '/api/v1/admin/accounts?group_id=api-group&page=1&page_size=5')
  assert.equal(listed.body.data.total, 1)
  assert.equal(listed.body.data.items[0].id, 'api-account')
  const updated = await request(base, '/api/v1/admin/accounts/api-account', { method: 'PUT', body: { priority: 12, concurrency: 4 } })
  assert.equal(updated.body.data.priority, 12)
  assert.equal(updated.body.data.concurrency, 4)

  const blockedGroupDelete = await request(base, '/api/v1/admin/groups/api-group', { method: 'DELETE' })
  assert.equal(blockedGroupDelete.status, 409)
  const deleted = await request(base, '/api/v1/admin/accounts/api-account', { method: 'DELETE' })
  assert.equal(deleted.body.data.deleted, true)
  assert.equal(store.getAccount('api-account'), null)
  assert.equal((await request(base, '/api/v1/admin/groups/api-group', { method: 'DELETE' })).status, 200)
})

test('ModelTrace HTTP routes validate bank/config, create and read runs, and reject invalid records', async t => {
  const { base, modeltrace } = await createTestServer(t)
  const config = await request(base, '/api/v1/admin/modeltrace/config')
  assert.equal(config.status, 200)
  assert.equal(config.body.data.model, 'model-a')
  assert.equal((await request(base, '/api/v1/admin/modeltrace/bank')).body.data.ready, true)

  const badConfig = await request(base, '/api/v1/admin/modeltrace/config', { method: 'PUT', body: { unknown: true } })
  assert.equal(badConfig.status, 400)
  const imported = await request(base, '/api/v1/admin/accounts', { method: 'POST', body: {
    account_id: 'trace-api-account', group_ids: ['api-trace-group'],
    credential: { access_token: 'trace-secret-token-value' },
  } })
  assert.equal(imported.status, 400)
  const group = await request(base, '/api/v1/admin/groups', { method: 'POST', body: { id: 'api-trace-group', name: 'Trace' } })
  assert.equal(group.status, 201)
  const account = await request(base, '/api/v1/admin/accounts', { method: 'POST', body: {
    account_id: 'trace-api-account', group_ids: ['api-trace-group'],
    credential: { access_token: 'trace-secret-token-value' },
  } })
  assert.equal(account.status, 201)
  const queued = await request(base, '/api/v1/admin/modeltrace/run', { method: 'POST', body: { account_id: account.body.data.id } })
  assert.equal(queued.status, 202)
  const saved = await modeltrace.wait(queued.body.data.id)
  assert.equal(saved.status, 'match')
  const byId = await request(base, `/api/v1/admin/modeltrace/runs/${saved.id}`)
  assert.equal(byId.body.data.status, 'match')
  assert.equal((await request(base, `/api/v1/admin/modeltrace/runs/${saved.id}/cancel`, { method: 'POST' })).body.data.canceled, false)
  assert.equal((await request(base, '/api/v1/admin/modeltrace/runs?page=1&page_size=10')).body.data.total, 1)
  assert.equal((await request(base, '/api/v1/admin/modeltrace/runs/not-found')).status, 404)
  assert.equal(modeltrace.getAccountConfig(account.body.data).enabled, true)
})

test('request body size limit and malformed JSON produce stable client errors', async t => {
  const store = new Store({ filename: ':memory:', encryptionKey: ENCRYPTION_KEY })
  const pool = new AccountPool({ store, lifecycle: { async provision() {}, async remove() {} } })
  const modeltrace = new ModelTrace({ store, accountPool: pool })
  const server = createIntegrationServer({ store, accountPool: pool, modeltrace, managementToken: TOKEN, maxBodyBytes: 24 })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  t.after(async () => { await modeltrace.close(); await new Promise(resolve => server.close(resolve)); store.close() })

  const large = await request(base, '/api/v1/admin/groups', { method: 'POST', body: { name: 'this request exceeds body cap' } })
  assert.equal(large.status, 413)
  const malformed = await fetch(`${base}/api/v1/admin/groups`, { method: 'POST', headers: {
    authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json',
  }, body: '{invalid json}' })
  assert.equal(malformed.status, 400)
  assert.equal((await malformed.json()).error.code, 'invalid_json')
})

test('pool dispatch and account import idempotency are exposed without credential leakage', async t => {
  const { base } = await createTestServer(t)
  const group = await request(base, '/api/v1/admin/groups', { method: 'POST', body: { id: 'dispatch-http', name: 'Dispatch HTTP' } })
  assert.equal(group.status, 201)
  const body = { account_id: 'idem-http', group_ids: ['dispatch-http'], credential: { access_token: 'idem-secret-token' } }
  const first = await request(base, '/api/v1/admin/accounts', { method: 'POST', body, extraHeaders: { 'idempotency-key': 'idem-1' } })
  const second = await request(base, '/api/v1/admin/accounts', { method: 'POST', body, extraHeaders: { 'idempotency-key': 'idem-1' } })
  assert.equal(first.status, 201)
  assert.equal(second.status, 201)
  assert.deepEqual(second.body.data, first.body.data)
  assert.equal(JSON.stringify(second.body).includes('idem-secret-token'), false)
  const stats = await request(base, '/api/v1/admin/pool/stats?group_id=dispatch-http')
  assert.equal(stats.body.data.available, 1)
  const acquired = await request(base, '/api/v1/admin/pool/acquire', { method: 'POST', body: { request_id: 'http-request-1', group_ids: ['dispatch-http'] } })
  assert.equal(acquired.status, 200)
  assert.equal(acquired.body.data.account.id, 'idem-http')
  const released = await request(base, '/api/v1/admin/pool/release', { method: 'POST', body: { request_id: 'http-request-1', success: true } })
  assert.equal(released.body.data.released, true)
})

test('account health sync and modeltrace summary remain separate from credential fields', async t => {
  const { base } = await createTestServer(t)
  const group = await request(base, '/api/v1/admin/groups', { method: 'POST', body: { id: 'sync-http', name: 'Sync HTTP' } })
  assert.equal(group.status, 201)
  const account = await request(base, '/api/v1/admin/accounts', { method: 'POST', body: {
    account_id: 'sync-http-account', group_ids: ['sync-http'], credential: { access_token: 'sync-secret-token' },
  } })
  assert.equal(account.status, 201)
  const summary = await request(base, '/api/v1/admin/modeltrace/summary')
  assert.equal(summary.status, 200)
  assert.equal(Array.isArray(summary.body.data.accounts), true)
  assert.equal(JSON.stringify(summary.body).includes('sync-secret-token'), false)
})

test('HTTP ModelTrace run skips account action when global strategy drifts during sampling', async t => {
  let entered
  let release
  const started = new Promise(resolve => { entered = resolve })
  const gate = new Promise(resolve => { release = resolve })
  let calls = 0
  const { base, modeltrace } = await createTestServer(t, {
    runner: async ({ challenge }) => {
      calls++
      if (calls === 1) {
        entered()
        await gate
      }
      return { text: `model-b response for ${challenge.id}` }
    },
  })
  const group = await request(base, '/api/v1/admin/groups', { method: 'POST', body: { id: 'trace-drift', name: 'Trace drift' } })
  assert.equal(group.status, 201)
  const account = await request(base, '/api/v1/admin/accounts', { method: 'POST', body: {
    account_id: 'trace-drift-account', group_ids: ['trace-drift'], credential: { access_token: 'trace-drift-secret' },
  } })
  assert.equal(account.status, 201)
  const configured = await request(base, '/api/v1/admin/modeltrace/config', { method: 'PUT', body: {
    action: 'pause', consecutive_mismatches: 1,
  } })
  assert.equal(configured.status, 200)
  const queued = await request(base, '/api/v1/admin/modeltrace/run', { method: 'POST', body: { account_id: account.body.data.id } })
  assert.equal(queued.status, 202)
  await started
  const changed = await request(base, '/api/v1/admin/modeltrace/config', { method: 'PUT', body: {
    action: 'observe', consecutive_mismatches: 1,
  } })
  assert.equal(changed.status, 200)
  release()
  const saved = await modeltrace.wait(queued.body.data.id)
  assert.equal(saved.status, 'suspected_mismatch')
  assert.match(saved.action_skipped_reason, /检测期间策略/)
  assert.equal(modeltrace.summary().accounts[0].consecutive_mismatches, 0)
})

test('HTTP ModelTrace run skips account action when binding becomes stale during sampling', async t => {
  let entered
  let release
  const started = new Promise(resolve => { entered = resolve })
  const gate = new Promise(resolve => { release = resolve })
  let calls = 0
  const { base, store, modeltrace } = await createTestServer(t, {
    runner: async ({ challenge }) => {
      calls++
      if (calls === 1) {
        entered()
        await gate
      }
      return { text: `model-b response for ${challenge.id}` }
    },
  })
  const group = await request(base, '/api/v1/admin/groups', { method: 'POST', body: { id: 'slot-drift', name: 'Slot drift' } })
  assert.equal(group.status, 201)
  const account = await request(base, '/api/v1/admin/accounts', { method: 'POST', body: {
    account_id: 'slot-drift-account', group_ids: ['slot-drift'], credential: { access_token: 'slot-drift-secret' },
  } })
  assert.equal(account.status, 201)
  const configured = await request(base, '/api/v1/admin/modeltrace/config', { method: 'PUT', body: {
    action: 'pause', consecutive_mismatches: 1,
  } })
  assert.equal(configured.status, 200)
  const queued = await request(base, '/api/v1/admin/modeltrace/run', { method: 'POST', body: { account_id: account.body.data.id } })
  assert.equal(queued.status, 202)
  await started
  const current = store.getAccount(account.body.data.id)
  store.updateAccount(account.body.data.id, {
    binding: { ...current.binding, proxy_id: 'proxy-drift' },
    slot_binding_stale: true,
    schedulable: false,
  })
  release()
  const saved = await modeltrace.wait(queued.body.data.id)
  assert.equal(saved.status, 'error')
  assert.equal(saved.error.code, 'trace_context_changed')
  assert.equal(modeltrace.summary().accounts[0].consecutive_mismatches, 0)
})

test('HTTP ModelTrace run skips account action when a healthy slot egress changes', async t => {
  let entered
  let release
  const started = new Promise(resolve => { entered = resolve })
  const gate = new Promise(resolve => { release = resolve })
  let calls = 0
  let drifted = false
  const lifecycle = {
    async provision(binding) {
      return { vm_id: `vm-${binding.account_id}`, slot: {
        ready: true, status: 'running', egress: { proxy_id: 'proxy-a', timezone: 'UTC' },
      } }
    },
    async remove() {},
    async inspect(binding, vmId) {
      return { id: vmId, ready: true, status: 'running', health: { ok: true },
        egress: { proxy_id: drifted ? 'proxy-b' : 'proxy-a', timezone: 'UTC' } }
    },
  }
  const { base, modeltrace } = await createTestServer(t, {
    lifecycle,
    runner: async ({ challenge }) => {
      calls++
      if (calls === 1) {
        entered()
        await gate
      }
      return { text: `model-b response for ${challenge.id}` }
    },
  })
  const group = await request(base, '/api/v1/admin/groups', { method: 'POST', body: { id: 'egress-drift', name: 'Egress drift' } })
  assert.equal(group.status, 201)
  const account = await request(base, '/api/v1/admin/accounts', { method: 'POST', body: {
    account_id: 'egress-drift-account', group_ids: ['egress-drift'], credential: { access_token: 'egress-drift-secret' },
  } })
  assert.equal(account.status, 201)
  const configured = await request(base, '/api/v1/admin/modeltrace/config', { method: 'PUT', body: {
    action: 'pause', consecutive_mismatches: 1,
  } })
  assert.equal(configured.status, 200)
  const queued = await request(base, '/api/v1/admin/modeltrace/run', { method: 'POST', body: { account_id: account.body.data.id } })
  assert.equal(queued.status, 202)
  await started
  drifted = true
  const synced = await request(base, `/api/v1/admin/accounts/${account.body.data.id}/sync`, { method: 'POST' })
  assert.equal(synced.status, 200)
  assert.equal(synced.body.data.slot.egress.proxy_id, 'proxy-b')
  assert.equal(synced.body.data.status, 'ready')
  release()
  const saved = await modeltrace.wait(queued.body.data.id)
  assert.equal(saved.status, 'suspected_mismatch')
  assert.match(saved.action_skipped_reason, /执行槽状态/)
  assert.equal(modeltrace.summary().accounts[0].consecutive_mismatches, 0)
})
