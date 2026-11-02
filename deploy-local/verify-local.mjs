#!/usr/bin/env node
// Real HTTP checks for the isolated local stack. Never accepts compliance,
// imports credentials, provisions slots, or calls an inference endpoint.
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const runtime = path.join(root, 'runtime')
const outputDir = path.join(runtime, 'verification')
const expectedEndpoints = Object.freeze({
  sub2api: 'http://127.0.0.1:18083',
  integration: 'http://127.0.0.1:18084',
  vm2: 'http://127.0.0.1:18787',
})
const args = process.argv.slice(2)
if (args.includes('--help')) {
  console.log('node deploy-local/verify-local.mjs [--timeout-ms 20000]\nExit: 0 passed; 1 failed; 2 blocked. Evidence: runtime/verification/latest.json')
  process.exit(0)
}
let timeoutMs = 20_000
if (args.length) {
  if (args.length !== 2 || args[0] !== '--timeout-ms' || !/^\d+$/.test(args[1])) {
    console.error('Usage: node deploy-local/verify-local.mjs [--timeout-ms 20000]')
    process.exit(1)
  }
  timeoutMs = Number(args[1])
  if (timeoutMs < 1000 || timeoutMs > 120_000) {
    console.error('timeout-ms must be between 1000 and 120000')
    process.exit(1)
  }
}

const report = {
  schemaVersion: 1,
  runId: randomUUID(),
  startedAt: new Date().toISOString(),
  endpoints: expectedEndpoints,
  timeoutMs,
  checks: [],
  boundaries: {
    production8081Touched: false,
    complianceAccepted: false,
    accountCredentialsImported: false,
    slotLifecyclePerformed: false,
    providerInferencePerformed: false,
    browserVisualAcceptance: 'not_performed',
    directManagementIsProxyEvidence: false,
  },
  cleanup: { policyRestored: null, syntheticGroupDeleted: null },
}
const secretValues = new Set()
let secrets
let lock
let panelToken
let vm2Session
let originalPolicy
let changedPolicy
let restoreRequired = false
let syntheticGroupId
let syntheticGroupNames
let groupCreateAttempted = false

class VerificationError extends Error {
  constructor(code, status) {
    super(code)
    this.code = code
    this.httpStatus = status
  }
}
function expect(condition, code, status) {
  if (!condition) throw new VerificationError(code, status)
}
function rememberSecret(value) {
  if (typeof value === 'string' && value.length >= 6) secretValues.add(value)
  return value
}
function collectSecrets(value, key = '') {
  if (typeof value === 'string' && /password|secret|token|apikey|datakey|encryptionkey/i.test(key)) rememberSecret(value)
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) collectSecrets(v, k)
}
function redact(text) {
  for (const value of secretValues) text = text.split(value).join('[redacted]')
  return text
}
function safeError(error) {
  // Never include remote response bodies, URLs, login payloads, or stack traces.
  if (error instanceof VerificationError) return {
    error: error.code,
    ...(Number.isInteger(error.httpStatus) ? { httpStatus: error.httpStatus } : {}),
  }
  const name = error?.name
  return { error: name === 'TimeoutError' || name === 'AbortError' ? 'request_timeout' : 'local_or_transport_error' }
}
async function check(id, scope, operation) {
  const start = performance.now()
  try {
    const result = await operation()
    report.checks.push({ id, scope, status: 'passed', ...result?.evidence, durationMs: Math.round(performance.now() - start) })
    return result?.value
  } catch (error) {
    report.checks.push({ id, scope, status: 'failed', ...safeError(error), durationMs: Math.round(performance.now() - start) })
    return undefined
  }
}
function blocked(id, scope, reason, evidence = {}) {
  report.checks.push({ id, scope, status: 'blocked', reason, ...evidence })
}
async function request(service, route, { method = 'GET', token, body } = {}) {
  expect(Object.hasOwn(expectedEndpoints, service), 'unknown_service')
  expect(route.startsWith('/') && !route.startsWith('//'), 'invalid_route')
  const headers = { accept: 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  if (body !== undefined) headers['content-type'] = 'application/json'
  const response = await fetch(`${expectedEndpoints[service]}${route}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs), redirect: 'error',
  })
  const text = await response.text()
  expect(Buffer.byteLength(text) <= 16 * 1024 * 1024, 'response_too_large', response.status)
  let json
  try { json = JSON.parse(text) } catch { /* HTML and JavaScript checks use text only. */ }
  return { status: response.status, text, json, contentType: response.headers.get('content-type') || '' }
}
function integrationData(response, status = 200) {
  expect(response.status === status, 'unexpected_http_status', response.status)
  expect(response.json?.ok === true && Object.hasOwn(response.json, 'data'), 'invalid_integration_envelope', response.status)
  return response.json.data
}
async function integration(route, options = {}) {
  return request('integration', `/api/v1/admin${route}`, { token: secrets.integration.managementToken, ...options })
}

async function verifySub2api() {
  await check('sub2api.health', 'sub2api', async () => {
    const r = await request('sub2api', '/health')
    expect(r.status === 200 && r.json?.status === 'ok', 'invalid_health', r.status)
    return { evidence: { httpStatus: r.status } }
  })
  await check('sub2api.setup_complete', 'sub2api', async () => {
    const r = await request('sub2api', '/setup/status')
    expect(r.status === 200 && r.json?.data?.needs_setup === false, 'setup_not_complete', r.status)
    return { evidence: { httpStatus: r.status, needsSetup: false } }
  })
  let entryPath
  for (const route of ['/login', '/admin/account-pool', '/admin/modeltrace']) {
    await check(`sub2api.spa${route}`, 'embedded_frontend_http', async () => {
      const r = await request('sub2api', route)
      expect(r.status === 200 && r.contentType.includes('text/html') && /id=["']app["']/.test(r.text), 'invalid_spa_html', r.status)
      const script = r.text.match(/<script\b[^>]*src=["'](\/assets\/[^"']+\.js)["']/i)?.[1]
      if (script) entryPath = script
      return { evidence: { httpStatus: r.status, bytes: Buffer.byteLength(r.text), sha256: createHash('sha256').update(r.text).digest('hex') } }
    })
  }
  await check('sub2api.new_page_assets', 'embedded_frontend_http', async () => {
    expect(entryPath, 'entry_script_missing')
    const r = await request('sub2api', entryPath)
    expect(r.status === 200 && /javascript/.test(r.contentType), 'entry_script_unavailable', r.status)
    const chunks = ['AccountPoolView', 'ModelTraceView'].map(name => r.text.match(new RegExp(`${name}-[a-zA-Z0-9_-]+\\.js`))?.[0])
    expect(chunks.every(Boolean), 'new_page_chunks_missing_from_entry')
    for (const chunk of chunks) {
      const asset = await request('sub2api', `/assets/${chunk}`)
      expect(asset.status === 200 && /javascript/.test(asset.contentType), 'new_page_chunk_unavailable', asset.status)
    }
    return { evidence: { httpStatus: r.status, chunks } }
  })
  for (const route of ['/accounts', '/modeltrace/summary']) {
    await check(`proxy.anonymous${route}`, 'admin_proxy_authentication', async () => {
      const r = await request('sub2api', `/api/v1/admin/integration${route}`)
      expect(r.status === 401, 'anonymous_admin_route_not_denied', r.status)
      return { evidence: { httpStatus: r.status } }
    })
  }
  panelToken = await check('sub2api.admin_login', 'sub2api_real_session', async () => {
    const r = await request('sub2api', '/api/v1/auth/login', { method: 'POST', body: secrets.admin })
    expect(r.status === 200 && r.json?.data?.user?.role === 'admin' && typeof r.json.data.access_token === 'string', 'admin_login_failed', r.status)
    return { value: rememberSecret(r.json.data.access_token), evidence: { httpStatus: r.status, role: 'admin' } }
  })
  if (!panelToken) {
    blocked('proxy.authenticated_management', 'admin_proxy_end_to_end', 'real_admin_session_unavailable')
    return
  }
  await check('sub2api.auth_me', 'sub2api_real_session', async () => {
    const r = await request('sub2api', '/api/v1/auth/me', { token: panelToken })
    expect(r.status === 200 && r.json?.data?.role === 'admin', 'admin_me_failed', r.status)
    return { evidence: { httpStatus: r.status, role: 'admin' } }
  })
  const compliance = await check('sub2api.compliance_status', 'sub2api_real_session', async () => {
    const r = await request('sub2api', '/api/v1/admin/compliance', { token: panelToken })
    expect(r.status === 200 && typeof r.json?.data?.required === 'boolean', 'invalid_compliance_status', r.status)
    return { value: r.json.data, evidence: { httpStatus: r.status, required: r.json.data.required, version: r.json.data.version } }
  })
  if (!compliance) {
    blocked('proxy.authenticated_management', 'admin_proxy_end_to_end', 'compliance_status_unavailable')
    return
  }
  for (const route of ['/accounts', '/modeltrace/summary']) {
    const result = await check(`proxy.authenticated${route}`, compliance.required ? 'admin_proxy_compliance_gate' : 'admin_proxy_end_to_end', async () => {
      const r = await request('sub2api', `/api/v1/admin/integration${route}`, { token: panelToken })
      if (compliance.required) {
        expect(r.status === 423 && r.json?.code === 'ADMIN_COMPLIANCE_ACK_REQUIRED', 'expected_compliance_gate_missing', r.status)
        return { value: true, evidence: { httpStatus: r.status, gateVerified: true } }
      }
      integrationData(r)
      return { value: true, evidence: { httpStatus: r.status, throughGoAdminProxy: true } }
    })
    if (compliance.required && result) blocked(`proxy.end_to_end${route}`, 'admin_proxy_end_to_end', 'user_compliance_acknowledgement_required', { httpStatus: 423 })
  }
}

async function verifyIntegration() {
  await check('integration.health', 'integration_direct', async () => {
    const r = await request('integration', '/health')
    const data = integrationData(r)
    expect(data.status === 'ready', 'integration_not_ready', r.status)
    return { evidence: { httpStatus: r.status, vm2Configured: data.vm2_configured === true } }
  })
  await check('integration.anonymous_denied', 'integration_direct', async () => {
    const r = await request('integration', '/api/v1/admin/accounts')
    expect(r.status === 401, 'management_auth_missing', r.status)
    return { evidence: { httpStatus: r.status } }
  })
  const emptyPool = await check('integration.empty_account_pool', 'integration_direct', async () => {
    const r = await integration('/accounts')
    const data = integrationData(r)
    expect(Array.isArray(data.items) && Number.isInteger(data.total), 'invalid_account_list', r.status)
    expect(data.total === 0 && data.items.length === 0, 'isolated_pool_is_not_empty', r.status)
    return { value: true, evidence: { httpStatus: r.status, accountCount: data.total } }
  })
  await check('integration.pool_stats', 'integration_direct', async () => {
    const r = await integration('/pool/stats')
    const data = integrationData(r)
    expect(data && typeof data === 'object', 'invalid_pool_stats', r.status)
    return { evidence: { httpStatus: r.status } }
  })
  const idleTrace = await check('integration.modeltrace_summary', 'integration_direct', async () => {
    const r = await integration('/modeltrace/summary')
    const data = integrationData(r)
    expect(Number.isInteger(data.active_runs), 'invalid_modeltrace_summary', r.status)
    expect(data.active_runs === 0, 'modeltrace_is_active', r.status)
    return { value: true, evidence: { httpStatus: r.status, activeRuns: data.active_runs, bankReady: data.bank?.ready === true } }
  })
  originalPolicy = await check('integration.modeltrace_policy_read', 'integration_direct', async () => {
    const r = await integration('/modeltrace/config')
    const data = integrationData(r)
    expect(Number.isInteger(data.interval_seconds) && typeof data.enabled === 'boolean', 'invalid_modeltrace_policy', r.status)
    return { value: data, evidence: { httpStatus: r.status, enabled: data.enabled, trigger: data.trigger } }
  })
  if (emptyPool && idleTrace && originalPolicy) {
    changedPolicy = { ...originalPolicy, interval_seconds: originalPolicy.interval_seconds === 604800 ? 604799 : originalPolicy.interval_seconds + 1 }
    await check('integration.modeltrace_policy_write_read', 'integration_direct', async () => {
      restoreRequired = true
      report.cleanup.policyRestored = false
      const written = integrationData(await integration('/modeltrace/config', { method: 'PUT', body: changedPolicy }))
      expect(isDeepStrictEqual(written, changedPolicy), 'policy_write_mismatch')
      const read = integrationData(await integration('/modeltrace/config'))
      expect(isDeepStrictEqual(read, changedPolicy), 'policy_read_after_write_mismatch')
      return { evidence: { httpStatus: 200, changedField: 'interval_seconds', inferenceTriggered: false } }
    })
    await restorePolicy()
  } else {
    blocked('integration.modeltrace_policy_write_read', 'integration_direct', 'requires_empty_pool_idle_trace_and_readable_policy')
  }
  syntheticGroupId = `local-verification-${report.runId}`
  syntheticGroupNames = [`Local verification ${report.runId}`, `Local verification updated ${report.runId}`]
  await check('integration.synthetic_group_create_update', 'integration_direct', async () => {
    const existing = integrationData(await integration('/groups'))
    expect(Array.isArray(existing) && !existing.some(group => group.id === syntheticGroupId), 'synthetic_group_collision')
    groupCreateAttempted = true
    report.cleanup.syntheticGroupDeleted = false
    const created = integrationData(await integration('/groups', { method: 'POST', body: { id: syntheticGroupId, name: syntheticGroupNames[0] } }), 201)
    expect(created.id === syntheticGroupId, 'synthetic_group_create_mismatch')
    const updated = integrationData(await integration(`/groups/${syntheticGroupId}`, { method: 'PUT', body: { name: syntheticGroupNames[1], status: 'inactive' } }))
    expect(updated.name === syntheticGroupNames[1] && updated.status === 'inactive', 'synthetic_group_update_mismatch')
    const list = integrationData(await integration('/groups'))
    expect(Array.isArray(list) && list.some(group => group.id === syntheticGroupId && group.name === syntheticGroupNames[1] && group.status === 'inactive'), 'synthetic_group_read_mismatch')
    return { evidence: { createHttpStatus: 201, updateHttpStatus: 200, onlySyntheticGroupTouched: true } }
  })
  await deleteSyntheticGroup()
}

async function restorePolicy() {
  if (!restoreRequired) return
  await check('integration.modeltrace_policy_restore', 'integration_direct_cleanup', async () => {
    const current = integrationData(await integration('/modeltrace/config'))
    expect(isDeepStrictEqual(current, changedPolicy) || isDeepStrictEqual(current, originalPolicy), 'policy_concurrently_changed_restore_refused')
    integrationData(await integration('/modeltrace/config', { method: 'PUT', body: originalPolicy }))
    const restored = integrationData(await integration('/modeltrace/config'))
    expect(isDeepStrictEqual(restored, originalPolicy), 'policy_restore_mismatch')
    restoreRequired = false
    report.cleanup.policyRestored = true
    return { evidence: { httpStatus: 200, originalPolicyRestored: true } }
  })
}
async function deleteSyntheticGroup() {
  if (!groupCreateAttempted) return
  await check('integration.synthetic_group_delete', 'integration_direct_cleanup', async () => {
    const groups = integrationData(await integration('/groups'))
    expect(Array.isArray(groups), 'invalid_group_list')
    const group = groups.find(item => item.id === syntheticGroupId)
    if (group) {
      expect(syntheticGroupNames.includes(group.name), 'synthetic_group_ownership_changed_delete_refused')
      const deleted = integrationData(await integration(`/groups/${syntheticGroupId}`, { method: 'DELETE' }))
      expect(deleted.deleted === true, 'synthetic_group_delete_failed')
    }
    const after = integrationData(await integration('/groups'))
    expect(Array.isArray(after) && !after.some(item => item.id === syntheticGroupId), 'synthetic_group_still_present')
    groupCreateAttempted = false
    report.cleanup.syntheticGroupDeleted = true
    return { evidence: { httpStatus: 200, absenceConfirmed: true } }
  })
}

async function verifyVm2() {
  await check('vm2.health', 'vm2_control_plane', async () => {
    const r = await request('vm2', '/health')
    expect(r.status === 200 && r.json?.status === 'ok', 'vm2_not_ready', r.status)
    return { evidence: { httpStatus: r.status } }
  })
  vm2Session = await check('vm2.panel_login', 'vm2_real_panel_session', async () => {
    const r = await request('vm2', '/api/panel/login', { method: 'POST', body: { username: secrets.vm2.adminUser, password: secrets.vm2.adminPassword } })
    expect(r.status === 200 && r.json?.ok === true && typeof r.json.token === 'string' && r.json.role === 'admin', 'vm2_panel_login_failed', r.status)
    return { value: rememberSecret(r.json.token), evidence: { httpStatus: r.status, role: 'admin' } }
  })
  if (vm2Session) {
    await check('vm2.empty_slots', 'vm2_real_panel_session', async () => {
      const r = await request('vm2', '/api/panel/vms', { token: vm2Session })
      const data = r.json?.data || r.json
      expect(r.status === 200 && Array.isArray(data?.items), 'invalid_vm2_slot_list', r.status)
      expect(data.items.length === 0 && data.total === 0, 'isolated_vm2_has_slots', r.status)
      return { evidence: { httpStatus: r.status, slotCount: data.items.length } }
    })
  } else blocked('vm2.empty_slots', 'vm2_real_panel_session', 'real_vm2_panel_session_unavailable')
  await check('vm2.models_anonymous_denied', 'vm2_catalog', async () => {
    const r = await request('vm2', '/v1/models')
    expect(r.status === 401, 'vm2_catalog_auth_missing', r.status)
    return { evidence: { httpStatus: r.status } }
  })
  await check('vm2.master_key_models', 'vm2_catalog', async () => {
    const r = await request('vm2', '/v1/models', { token: secrets.vm2.apiKey })
    expect(r.status === 200 && Array.isArray(r.json?.data), 'vm2_catalog_failed', r.status)
    return { evidence: { httpStatus: r.status, modelCount: r.json.data.length, inferencePerformed: false, catalogDoesNotProveInferenceAvailability: true } }
  })
  if (vm2Session) await check('vm2.panel_logout', 'vm2_session_cleanup', async () => {
    const r = await request('vm2', '/api/panel/logout', { method: 'POST', token: vm2Session, body: {} })
    expect(r.status === 200 && r.json?.ok === true, 'vm2_logout_failed', r.status)
    vm2Session = undefined
    return { evidence: { httpStatus: r.status } }
  })
}

async function main() {
  await mkdir(outputDir, { recursive: true })
  try {
    lock = await open(path.join(outputDir, '.verify.lock'), 'wx')
  } catch {
    throw new VerificationError('another_verifier_or_stale_lock_exists')
  }
  secrets = JSON.parse(await readFile(path.join(runtime, 'local-secrets.json'), 'utf8'))
  collectSecrets(secrets)
  expect(secrets.version === 1, 'unsupported_secrets_schema')
  for (const [name, endpoint] of Object.entries(expectedEndpoints)) expect(secrets.endpoints?.[name] === endpoint, 'unexpected_endpoint_refused')
  expect(secrets.admin?.email && secrets.admin?.password && secrets.integration?.managementToken && secrets.vm2?.adminUser && secrets.vm2?.adminPassword && secrets.vm2?.apiKey, 'required_local_credentials_missing')
  await verifySub2api()
  await verifyIntegration()
  await verifyVm2()
}

try {
  await main()
} catch (error) {
  report.checks.push({ id: 'verifier.execution', scope: 'local_verifier', status: 'failed', ...safeError(error) })
} finally {
  if (secrets) {
    // If a preceding write failed after dispatch, still inspect and restore its
    // outcome. No exploratory write or inference retry is performed.
    await restorePolicy()
    await deleteSyntheticGroup()
  }
  report.completedAt = new Date().toISOString()
  const count = status => report.checks.filter(item => item.status === status).length
  report.summary = {
    status: count('failed') ? 'failed' : count('blocked') ? 'blocked' : 'passed',
    passed: count('passed'), failed: count('failed'), blocked: count('blocked'),
    adminProxyEndToEndVerified: report.checks.filter(item => item.scope === 'admin_proxy_end_to_end' && item.status === 'passed' && item.throughGoAdminProxy).length === 2,
    directManagementChecksAreSeparate: true,
  }
  const serialized = redact(JSON.stringify(report, null, 2)) + '\n'
  try {
    // Do not overwrite a concurrent run's evidence when lock acquisition failed.
    if (lock) {
      const temp = path.join(outputDir, `${report.runId}.tmp`)
      await writeFile(temp, serialized, { encoding: 'utf8', mode: 0o600 })
      await rename(temp, path.join(outputDir, 'latest.json'))
    }
  } catch {
    report.summary.status = 'failed'
    report.summary.evidenceWriteFailed = true
  } finally {
    if (lock) {
      await lock.close()
      await unlink(path.join(outputDir, '.verify.lock')).catch(() => {})
    }
  }
  console.log(redact(JSON.stringify(report, null, 2)))
  process.exitCode = report.summary.status === 'failed' ? 1 : report.summary.status === 'blocked' ? 2 : 0
}
