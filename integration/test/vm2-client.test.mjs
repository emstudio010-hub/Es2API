import test from 'node:test'
import assert from 'node:assert/strict'
import { Vm2Client, vm2LifecycleTimeout } from '../src/vm2-client.mjs'

function jsonResponse(payload, status = 200) {
  return new Response(payload === null ? null : JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

test('VM2 client creates an empty slot, imports credentials, starts it and normalizes ready status', async () => {
  const requests = []
  const client = new Vm2Client({ baseUrl: 'http://vm2.test', controlToken: 'panel-token', fetchImpl: async (url, init) => {
    requests.push({ url, init, body: init.body ? JSON.parse(init.body) : null })
    if (url.endsWith('/api/panel/vms/create')) return jsonResponse({ vm: { id: 'vm-a' } })
    if (url.endsWith('/api/panel/vms/import')) return jsonResponse({ ok: true })
    if (url.endsWith('/api/panel/vms/vm-a/start')) return jsonResponse({ data: { status: 'running' } })
    if (url.endsWith('/api/panel/vms/vm-a')) return jsonResponse({ vm: { id: 'vm-a', status: 'running', schedulable: true, health: { ok: true } } })
    throw new Error(`unexpected request ${url}`)
  } })

  const created = await client.createSlot({ account_id: 'a', mode: 'pool' }, 'create-key')
  assert.equal(created.vm.id, 'vm-a')
  await client.importCredential('vm-a', { access_token: 'secret-token' }, 'import-key')
  await client.startSlot('vm-a', 'start-key')
  const status = await client.getSlot('vm-a')
  assert.equal(status.ready, true)
  assert.equal(requests[0].body.start, false)
  assert.deepEqual(requests[1].body, { vm_id: 'vm-a', mode: 'oauth', auth_json: JSON.stringify({
    access_token: 'secret-token', refresh_token: null, id_token: null, api_key: null,
  }) })
  assert.equal(requests[2].init.headers['idempotency-key'], 'start-key')
  assert.equal(requests.every(request => request.init.headers.authorization === 'Bearer panel-token'), true)
})

test('VM2 client treats start_error as a failed lifecycle operation and confirms deletion before returning', async () => {
  const requests = []
  let statusReads = 0
  const client = new Vm2Client({ baseUrl: 'http://vm2.test', controlToken: 'panel-token', fetchImpl: async (url, init) => {
    requests.push({ url, init })
    if (url.endsWith('/vm-b/start')) return jsonResponse({ start_error: 'container failed to boot' })
    if (url.endsWith('/vm-b/stop')) return jsonResponse({ ok: true })
    if (url.endsWith('/vm-b') && init.method === 'DELETE') return jsonResponse(null, 204)
    if (url.endsWith('/vm-b')) {
      statusReads++
      return statusReads === 1 ? jsonResponse({ vm: { id: 'vm-b', status: 'running', health: { ok: true } } }) : jsonResponse({ error: { message: 'not found', code: 'not_found' } }, 404)
    }
    throw new Error(`unexpected request ${url}`)
  } })

  await assert.rejects(() => client.startSlot('vm-b', 'start-key'), error => error.code === 'vm2_start_failed' && error.status === 502)
  const result = await client.deleteSlot('vm-b', 'delete-key')
  assert.equal(result.absence_confirmed, true)
  assert.deepEqual(requests.slice(-4).map(request => [request.init.method || 'GET', new URL(request.url).pathname]), [
    ['GET', '/api/panel/vms/vm-b'],
    ['POST', '/api/panel/vms/vm-b/stop'],
    ['DELETE', '/api/panel/vms/vm-b'],
    ['GET', '/api/panel/vms/vm-b'],
  ])
  assert.equal(requests.find(request => request.init.method === 'DELETE').init.headers['idempotency-key'], 'delete-key')
})

test('VM2 delete is idempotent when the slot is already absent', async () => {
  const client = new Vm2Client({ baseUrl: 'http://vm2.test', controlToken: 'panel-token', fetchImpl: async () => jsonResponse({}, 404) })
  const result = await client.deleteSlot('missing', 'delete-missing')
  assert.equal(result.already_absent, true)
})

test('expired panel sessions refresh once and preserve the lifecycle request and idempotency key', async () => {
  const requests = []
  let logins = 0
  const client = new Vm2Client({ baseUrl: 'http://vm2.test', username: 'operator', password: 'test-password', fetchImpl: async (url, init) => {
    requests.push({ url, init })
    if (url.endsWith('/login')) return jsonResponse({ token: `session-${++logins}` })
    if (init.headers.authorization === 'Bearer session-1') return jsonResponse({ error: { message: 'expired' } }, 401)
    return jsonResponse({ ok: true, data: { vm: { id: 'es2-a' } } })
  } })
  const result = await client.createSlot({ account_id: 'a' }, 'stable-create-key')
  assert.equal(result.data.vm.id, 'es2-a')
  assert.equal(logins, 2)
  const creates = requests.filter(request => request.url.endsWith('/create'))
  assert.equal(creates.length, 2)
  assert.equal(creates[0].init.body, creates[1].init.body)
  assert.equal(creates[1].init.headers['idempotency-key'], 'stable-create-key')
})

test('concurrent expired reads share one session refresh and do not replay forbidden requests', async () => {
  let logins = 0
  let reads = 0
  let forbidden = false
  const client = new Vm2Client({ baseUrl: 'http://vm2.test', username: 'operator', password: 'test-password', fetchImpl: async (url, init) => {
    if (url.endsWith('/login')) { logins++; return jsonResponse({ token: 'fresh-session' }) }
    reads++
    if (forbidden) return jsonResponse({}, 403)
    if (init.headers.authorization === 'Bearer expired-session') return jsonResponse({}, 401)
    return jsonResponse({ data: { vm: { id: 'es2-a', status: 'running' } } })
  } })
  client.sessionToken = 'expired-session'
  await Promise.all([client.getSlot('es2-a'), client.getSlot('es2-a')])
  assert.equal(logins, 1)
  assert.equal(reads, 4)
  forbidden = true
  await assert.rejects(() => client.getSlot('es2-a'), error => error.status === 403)
  assert.equal(logins, 1)
  assert.equal(reads, 5)
})

test('persistent unauthorized requests stop after one refresh and token-only auth never retries', async () => {
  let logins = 0
  let requests = 0
  const client = new Vm2Client({ baseUrl: 'http://vm2.test', username: 'operator', password: 'test-password', fetchImpl: async url => {
    if (url.endsWith('/login')) { logins++; return jsonResponse({ token: 'rejected-session' }) }
    requests++
    return jsonResponse({}, 401)
  } })
  await assert.rejects(() => client.getSlot('es2-a'), error => error.status === 401)
  assert.equal(logins, 2)
  assert.equal(requests, 2)
  const tokenClient = new Vm2Client({ baseUrl: 'http://vm2.test', controlToken: 'expired-token', fetchImpl: async () => { requests++; return jsonResponse({}, 401) } })
  await assert.rejects(() => tokenClient.getSlot('es2-a'), error => error.status === 401)
  assert.equal(requests, 3)
})

test('lifecycle timeout configuration has a bounded default and rejects invalid values', () => {
  assert.equal(vm2LifecycleTimeout(), 360000)
  assert.equal(vm2LifecycleTimeout('600000'), 600000)
  for (const value of ['oops', 0, -1, 14999, 900001, 15000.5, Infinity]) {
    assert.throws(() => vm2LifecycleTimeout(value), /VM2API_LIFECYCLE_TIMEOUT_MS/)
  }
})

test('ordinary reads and login retain the short timeout while lifecycle writes get the configured timeout', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const makeClient = (credentials = {}) => {
    const entered = Promise.withResolvers()
    let signal
    const client = new Vm2Client({ baseUrl: 'http://vm2.test', controlToken: 'panel-token', ...credentials,
      lifecycleTimeoutMs: 360000, fetchImpl: async (url, init) => {
        signal = init.signal
        entered.resolve()
        return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
      } })
    return { client, entered: entered.promise, signal: () => signal }
  }
  for (const [operation, expectedTimeout] of [
    ['getSlot', 15000], ['login', 15000], ['createSlot', 360000], ['startSlot', 360000], ['importCredential', 360000], ['stopSlot', 360000],
  ]) {
    const subject = makeClient({ username: 'operator', password: 'test-password' })
    const args = operation === 'createSlot' ? [{ account_id: 'a' }, 'create-key']
      : operation === 'importCredential' ? ['es2-a', { access_token: 'test-access' }, 'import-key'] : ['es2-a']
    const pending = assert.rejects(() => subject.client[operation](...args), error => error.name === 'AbortError')
    await subject.entered
    t.mock.timers.tick(expectedTimeout - 1)
    assert.equal(subject.signal().aborted, false, `${operation} must not time out early`)
    t.mock.timers.tick(1)
    await pending
  }
})
