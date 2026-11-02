import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ACCOUNT_MODES,
  buildCodexImportRequest,
  buildVmProvisionRequest,
  credentialFingerprint,
  extractControlFields,
  mergeControlFields,
  normalizeAccountBinding,
  normalizeOpenAICredential,
  normalizeVmStatus,
  publicCredentialStatus,
} from '../src/contract.mjs'

test('normalizes nested OpenAI credentials without exposing raw values', () => {
  const credential = normalizeOpenAICredential({ auth: { accessToken: 'access-secret', refresh_token: 'refresh-secret' } })
  assert.deepEqual(publicCredentialStatus(credential), {
    has_access_token: true,
    has_refresh_token: true,
    has_id_token: false,
    has_api_key: false,
    fingerprint: credentialFingerprint(credential),
  })
  assert.equal(JSON.stringify(publicCredentialStatus(credential)).includes('access-secret'), false)
})

test('pool and lease group semantics remain explicit and IP binding is fixed', () => {
  const pool = normalizeAccountBinding({ id: 7, mode: 'pool', group_id: 9, proxy_id: 11 })
  assert.equal(pool.mode, ACCOUNT_MODES.POOL)
  assert.equal(pool.group_strategy, 'shared')
  assert.deepEqual(pool.group_ids, ['9'])
  assert.equal(pool.ip_policy, 'fixed')
  assert.equal(pool.ip_selection, 'create_only')
  assert.equal(pool.identity_policy, 'ip_derived')
  const lease = normalizeAccountBinding({ account_id: 'a', mode: 'lease' })
  assert.equal(lease.group_strategy, 'per_slot')
})

test('provision request selects the OpenAI Codex Docker runtime and create-time IP identity policy', () => {
  const request = buildVmProvisionRequest({ account_id: 'acct-1', mode: 'pool', group_ids: ['g1'], proxy_id: 'px-create' })
  assert.equal(request.runtime_type, 'docker')
  assert.equal(request.codex_kernel, true)
  assert.equal(request.start, false)
  assert.equal(request.slot_binding.ip_policy, 'fixed')
  assert.equal(request.ip_selection, 'create_only')
  assert.equal(request.identity_policy, 'ip_derived')
  assert.equal(request.proxy_id, 'px-create')
  assert.equal(Object.hasOwn(request, 'timezone'), false)
  assert.deepEqual(buildCodexImportRequest('es2-acct-1', { access_token: 'secret' }), {
    vm_id: 'es2-acct-1',
    mode: 'oauth',
    auth_json: JSON.stringify({ access_token: 'secret', refresh_token: null, id_token: null, api_key: null }),
  })
  assert.throws(() => buildCodexImportRequest('es2-key-1', { api_key: 'sk-test' }), /不支持 OpenAI API Key/)
})

test('priority, fast and ultrafast survive protocol adaptation', () => {
  const controls = extractControlFields({ priority: 'high', fast: 'true', ignored: 'x' }, { ultrafast: true, model: 'gpt' })
  assert.deepEqual(controls, { headers: { priority: 'high', fast: 'true' }, body: { ultrafast: true } })
  const merged = mergeControlFields({ model: 'gpt' }, { input: [] }, { priority: 'high' }, { fast: false })
  assert.deepEqual(merged, { headers: { model: 'gpt', priority: 'high' }, body: { input: [], fast: false } })
})

test('public VM status is reduced to lifecycle and egress metadata', () => {
  assert.deepEqual(normalizeVmStatus({ vm: { id: 'vm-1', status: 'running', schedulable: true, health: { ok: true }, proxy: { id: 'px-1' } } }), {
    id: 'vm-1',
    status: 'running',
    ready: true,
    schedulable: true,
    health: { ok: true, code: null, checked_at: null },
    egress: { bound: true, proxy_id: 'px-1', timezone: null },
  })
})

test('missing VM2 health is represented as unknown rather than an explicit failure', () => {
  const status = normalizeVmStatus({ vm: { id: 'vm-unknown-health', status: 'running' } })
  assert.equal(status.ready, true)
  assert.equal(status.health.ok, null)
})

test('real VM2 detail Codex kernel health prevents an unhealthy running slot from being ready', () => {
  const payload = { ok: true, data: {
    vm: { id: 'es2-acct-1', status: 'running', schedulable: true, proxy: { id: 'px-fixed' } },
    kernel: { codex_health: { reachable: false, status: null, error_code: 'health_check_failed' } },
  } }
  const failed = normalizeVmStatus(payload)
  assert.equal(failed.ready, false)
  assert.equal(failed.health.ok, false)
  assert.equal(failed.health.code, 'health_check_failed')
  assert.equal(failed.egress.proxy_id, 'px-fixed')
  payload.data.kernel.codex_health = { reachable: true, status: 200 }
  assert.equal(normalizeVmStatus(payload).ready, true)
})
