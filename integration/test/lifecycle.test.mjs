import test from 'node:test'
import assert from 'node:assert/strict'
import { AccountLifecycle } from '../src/lifecycle.mjs'

function fakeVm2({ importFails = false, notReady = false } = {}) {
  const calls = []
  return {
    calls,
    async createSlot(binding, key) {
      calls.push(['create', binding, key])
      return { ok: true, vm: { id: 'es2-acct-1' } }
    },
    async importCredential(vmId, credential, key) {
      calls.push(['import', vmId, credential, key])
      if (importFails) throw Object.assign(new Error('import failed'), { code: 'import_failed' })
      return { ok: true }
    },
    async getSlot(vmId) {
      calls.push(['status', vmId])
      return { id: vmId, status: notReady ? 'error' : 'running', ready: !notReady }
    },
    async deleteSlot(vmId, key) {
      calls.push(['delete', vmId, key])
      return { ok: true }
    },
  }
}

test('provision reaches ready only after create, import and status', async () => {
  const vm2 = fakeVm2()
  const states = []
  const lifecycle = new AccountLifecycle({ vm2, onState: (state) => states.push(state) })
  const result = await lifecycle.provision({ account_id: 'acct-1', mode: 'lease' }, { access_token: 'secret' })
  assert.equal(result.status, 'running')
  assert.deepEqual(vm2.calls.map((call) => call[0]), ['create', 'import', 'status'])
  assert.equal(states.at(-1).phase, 'ready')
  assert.equal(JSON.stringify(states).includes('secret'), false)
})

test('failed credential import retains the slot for an explicit retry', async () => {
  const vm2 = fakeVm2({ importFails: true })
  const lifecycle = new AccountLifecycle({ vm2 })
  await assert.rejects(() => lifecycle.provision({ account_id: 'acct-1' }, { refresh_token: 'secret' }), /import failed/)
  assert.deepEqual(vm2.calls.map((call) => call[0]), ['create', 'import'])
})

test('explicit retry reuses its recorded slot instead of conflicting with VM2 create', async () => {
  const vm2 = fakeVm2()
  vm2.createSlot = async () => { throw new Error('VM2 returns 409 for a duplicate slot id') }
  const lifecycle = new AccountLifecycle({ vm2 })
  const result = await lifecycle.provision({ account_id: 'acct-1' }, { access_token: 'secret' }, { existingVmId: 'es2-acct-1' })
  assert.equal(result.vm_id, 'es2-acct-1')
  assert.deepEqual(vm2.calls.map(call => call[0]), ['status', 'import', 'status'])
})

test('retry recreates its recorded slot only after VM2 confirms it is absent', async () => {
  const vm2 = fakeVm2()
  const getSlot = vm2.getSlot
  let reads = 0
  vm2.getSlot = async (...args) => {
    if (++reads === 1) throw Object.assign(new Error('not found'), { status: 404 })
    return getSlot(...args)
  }
  const result = await new AccountLifecycle({ vm2 }).provision({ account_id: 'acct-1' }, { access_token: 'secret' }, { existingVmId: 'es2-acct-1' })
  assert.equal(result.status, 'running')
  assert.deepEqual(vm2.calls.map(call => call[0]), ['create', 'import', 'status'])
})

test('retry retains the recorded slot on inspection failure and rejects mismatched bindings', async () => {
  const vm2 = fakeVm2()
  const lifecycle = new AccountLifecycle({ vm2 })
  await assert.rejects(() => lifecycle.provision({ account_id: 'acct-1' }, { access_token: 'secret' }, { existingVmId: 'es2-other' }),
    error => error.code === 'vm2_slot_binding_mismatch')
  assert.deepEqual(vm2.calls, [])

  vm2.getSlot = async () => { throw Object.assign(new Error('unavailable'), { status: 503 }) }
  await assert.rejects(() => lifecycle.provision({ account_id: 'acct-1' }, { access_token: 'secret' }, { existingVmId: 'es2-acct-1' }),
    error => error.status === 503 && error.vm_id === 'es2-acct-1')
  assert.deepEqual(vm2.calls, [])

  vm2.getSlot = async () => ({ id: 'es2-other', ready: true })
  await assert.rejects(() => lifecycle.provision({ account_id: 'acct-1' }, { access_token: 'secret' }, { existingVmId: 'es2-acct-1' }),
    error => error.code === 'vm2_slot_binding_mismatch')
  assert.deepEqual(vm2.calls, [])
})

test('not-ready slot is never reported as running and is retained for inspection', async () => {
  const vm2 = fakeVm2({ notReady: true })
  const lifecycle = new AccountLifecycle({ vm2 })
  await assert.rejects(() => lifecycle.provision({ account_id: 'acct-1' }, { access_token: 'secret' }), (error) => {
    assert.equal(error.code, 'vm2_slot_not_ready')
    return true
  })
  assert.deepEqual(vm2.calls.map((call) => call[0]), ['create', 'import', 'status'])
})

test('remove deletes the bound slot with an idempotency key', async () => {
  const vm2 = fakeVm2()
  const lifecycle = new AccountLifecycle({ vm2 })
  const result = await lifecycle.remove({ account_id: 'acct-1' }, 'es2-acct-1')
  assert.equal(result.phase, 'deleted')
  assert.equal(vm2.calls[0][0], 'delete')
  assert.equal(vm2.calls[0][1], 'es2-acct-1')
})

test('provision generation changes VM2 idempotency keys when a slot is rebuilt', async () => {
  const vm2 = fakeVm2()
  const lifecycle = new AccountLifecycle({ vm2 })
  await lifecycle.provision({ account_id: 'acct-generation' }, { access_token: 'secret-a' }, { generation: 1 })
  await lifecycle.provision({ account_id: 'acct-generation' }, { access_token: 'secret-b' }, { generation: 2 })
  const createKeys = vm2.calls.filter(call => call[0] === 'create').map(call => call[2])
  const importKeys = vm2.calls.filter(call => call[0] === 'import').map(call => call[3])
  assert.deepEqual(createKeys, ['account-create:g1:acct-generation', 'account-create:g2:acct-generation'])
  assert.deepEqual(importKeys, ['account-import:g1:acct-generation', 'account-import:g2:acct-generation'])

  await lifecycle.remove({ account_id: 'acct-generation' }, 'es2-acct-1', { generation: 1 })
  await lifecycle.remove({ account_id: 'acct-generation' }, 'es2-acct-1', { generation: 2 })
  const deleteKeys = vm2.calls.filter(call => call[0] === 'delete').map(call => call[2])
  assert.deepEqual(deleteKeys, [
    'account-delete:g1:acct-generation:es2-acct-1',
    'account-delete:g2:acct-generation:es2-acct-1',
  ])
})
