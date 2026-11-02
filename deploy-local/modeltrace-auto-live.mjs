// One managed-key user call -> VM2 usage callback -> automatic ModelTrace.
// This script never posts /modeltrace/run and never resubmits inference.
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { DatabaseSync, backup } from 'node:sqlite'
import { Vm2Client } from '../integration/src/vm2-client.mjs'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const runtime = path.join(root, 'runtime')
const args = process.argv.slice(2)
const accountId = args.find(arg => arg.startsWith('--account='))?.slice(10)
const execute = args.includes('--execute-once')
const stamp = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`
const keyName = `modeltrace-auto-${stamp}`
const output = path.join(runtime, 'verification', `modeltrace-auto-live-${stamp}.json`)
const evidence = {
  schemaVersion: 1, started_at: new Date().toISOString(), fixture: false,
  entry: 'vm2-managed-key-to-automatic-modeltrace', account_id: accountId || null,
  submission_attempts: 0, automatic_resubmissions: 0, provider_inference_requested: false,
  chain_verified: false, verified: false,
}
let managementToken, temporaryKey, panel, originalPolicy
let policyChanged = false
let keyCreationAttempted = false
let keyId = null
let runId = null
let observedModel = null
let beforeRunIds = new Set()

function fail(code) { throw Object.assign(new Error('Automatic ModelTrace acceptance failed'), { safeCode: code }) }
async function save() {
  await fs.mkdir(path.dirname(output), { recursive: true })
  await fs.writeFile(output, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 })
}
async function api(route, method = 'GET', body) {
  const response = await fetch(`http://127.0.0.1:18084/api/v1/admin${route}`, {
    method, headers: { authorization: `Bearer ${managementToken}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(15000),
  })
  const payload = await response.json()
  if (!response.ok || payload.ok !== true) fail(`management_http_${response.status}`)
  return payload.data
}
const accountRoute = `/accounts/${encodeURIComponent(accountId || '')}`
const policyRoute = `${accountRoute}/modeltrace`
const runsRoute = `/modeltrace/runs?account_id=${encodeURIComponent(accountId || '')}&page_size=100`
async function panelApi(route, options = {}) {
  const payload = await panel.request(route, { ...options, retryAuthentication: false })
  if (payload.ok !== true) fail('vm2_panel_rejected')
  return payload
}
async function backupDatabases() {
  const destination = path.join(runtime, 'verification', 'backups', `auto-${stamp}`)
  await fs.mkdir(destination, { recursive: true, mode: 0o700 })
  for (const [source, name] of [
    [path.join(runtime, 'integration', 'es2api.sqlite'), 'integration-es2api.sqlite'],
    [path.join(runtime, 'vm2', 'data', 'kin.db'), 'vm2-data-kin.db'],
  ]) {
    // Do not instantiate Store: its startup recovery mutates active-run state.
    const db = new DatabaseSync(source, { readOnly: true })
    try { await backup(db, path.join(destination, name)) } finally { db.close() }
    await fs.chmod(path.join(destination, name), 0o600)
  }
  evidence.backup_directory = destination
  await save()
}
async function restorePolicy() {
  await api(policyRoute, 'PUT', { inherit: true })
  if (Object.keys(originalPolicy.overrides || {}).length) await api(policyRoute, 'PUT', originalPolicy.overrides)
  evidence.policy_restored = true
}
function numericUsage(usage) {
  if (!usage || typeof usage !== 'object') return null
  return Object.fromEntries(['input_tokens', 'output_tokens', 'total_tokens']
    .filter(key => Number.isFinite(usage[key])).map(key => [key, usage[key]]))
}
function outputText(payload) {
  if (typeof payload?.output_text === 'string') return payload.output_text
  return (payload?.output || []).flatMap(item => item?.content || [])
    .filter(item => typeof item?.text === 'string').map(item => item.text).join('')
}

try {
  if (!accountId || !/^[a-z0-9][a-z0-9._:-]{0,199}$/i.test(accountId) ||
      args.filter(arg => arg.startsWith('--account=')).length !== 1 ||
      args.filter(arg => arg === '--execute-once').length > 1 ||
      args.some(arg => arg !== '--execute-once' && !arg.startsWith('--account='))) fail('invalid_arguments')
  let secrets = JSON.parse(await fs.readFile(path.join(runtime, 'local-secrets.json'), 'utf8'))
  managementToken = secrets.integration.managementToken
  panel = new Vm2Client({ baseUrl: 'http://127.0.0.1:18787', username: secrets.vm2.adminUser, password: secrets.vm2.adminPassword })
  secrets = null
  const [account, summary, policy, history] = await Promise.all([
    api(accountRoute), api('/modeltrace/summary'), api(policyRoute), api(runsRoute),
  ])
  originalPolicy = policy
  beforeRunIds = new Set(history.items.map(run => run.id))
  const model = policy.readiness?.model || policy.effective_config.model
  observedModel = model
  evidence.preflight = {
    vm_id: account.vm_id, proxy_id: account.binding?.proxy_id || null,
    successful_requests: account.successful_requests, model,
    readiness: policy.readiness, bridge_configured: summary.usage_bridge?.configured === true,
    last_poll_at: summary.usage_bridge?.last_poll_at || null, delivery_error: summary.usage_bridge?.last_error || null,
    active_runs: summary.active_runs, global_enabled: summary.config.enabled,
    automatic_enabled: policy.effective_config.enabled,
    bank_revision: summary.bank.revision, bank_method: summary.bank.method,
  }
  if (!policy.readiness?.ready || !account.schedulable) fail('trace_not_ready')
  if (summary.active_runs !== 0) fail('active_runs_present')
  if (summary.config.enabled !== true) fail('global_monitoring_disabled')
  if (summary.usage_bridge?.configured !== true) fail('usage_bridge_unconfigured')
  if (!summary.usage_bridge.last_poll_at || summary.usage_bridge.last_error) fail('usage_bridge_not_connected')
  if (summary.bank.method !== 'shared-detector-v2' || summary.bank.calibrated_samples !== 3) fail('numeric_bank_required')
  evidence.preflight_verified = true

  if (execute) {
    await backupDatabases()
    await panel.login()
    policyChanged = true // A transport failure can occur after the write commits.
    await api(policyRoute, 'PUT', {
      enabled: true, trigger: 'requests', every_requests: 1, action: 'observe', sample_count: 3,
      model, model_mode: 'specified',
    })
    const armed = await api(policyRoute)
    if (armed.effective_config.enabled !== true || armed.effective_config.every_requests !== 1 ||
        armed.effective_config.action !== 'observe' || armed.automation?.ready !== true) fail('automatic_policy_not_armed')
    keyCreationAttempted = true
    evidence.temporary_key = { name: keyName, creation_attempted: true, deleted: false }
    await save()
    const created = await panelApi('/api/panel/api-keys', { method: 'POST', body: {
      name: keyName, category: 'oauth', group_type: 'openai', allowed_vms: [account.vm_id],
      max_concurrency: 1, quota_requests: 1, expires_at: new Date(Date.now() + 3600000).toISOString(),
    } })
    keyId = created.item?.id || null
    temporaryKey = created.item?.key
    evidence.temporary_key.id = keyId
    if (!keyId || typeof temporaryKey !== 'string' || temporaryKey.length < 16 ||
        created.item.group_type !== 'openai' || created.item.allowed_vms?.length !== 1 ||
        created.item.allowed_vms[0] !== account.vm_id || created.item.quota_requests !== 1) fail('temporary_key_scope_invalid')
    evidence.submission_attempts = 1
    evidence.provider_inference_requested = true
    evidence.submitted_at = new Date().toISOString()
    await save() // One explicit inference attempt, even if the response is lost.
    const response = await fetch('http://127.0.0.1:18787/v1/responses', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(90000),
      headers: { authorization: `Bearer ${temporaryKey}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ model, input: 'Reply with exactly OK.', stream: false, store: false }),
    })
    evidence.user_response = { http_status: response.status }
    if (!response.ok) { await response.body?.cancel(); fail(`user_request_http_${response.status}`) }
    let payload = await response.json()
    const text = outputText(payload)
    evidence.user_response = {
      http_status: response.status, completed: payload.status === 'completed', has_output: !!text,
      output_sha256: crypto.createHash('sha256').update(text).digest('hex'), output_length: text.length,
      usage: numericUsage(payload.usage),
    }
    if (payload.error || payload.status !== 'completed' || !text) fail('user_request_not_completed')
    payload = null
    temporaryKey = null
    await save()

    const deadline = Date.now() + 330000
    let run = null
    while (Date.now() < deadline) {
      const current = await api(runsRoute)
      const newRuns = current.items.filter(item => !beforeRunIds.has(item.id) && item.reason === 'requests' && item.model === model)
      if (newRuns.length > 1) fail('unexpected_multiple_automatic_runs')
      if (newRuns.length === 1) {
        run = newRuns[0]
        runId = run.id
        evidence.run_id = runId
        evidence.status = run.status
        evidence.finished_samples = run.samples?.length || 0
        await save()
        if (!['queued', 'running'].includes(run.status)) break
      }
      await new Promise(resolve => setTimeout(resolve, 1500))
    }
    if (!run || ['queued', 'running'].includes(run.status)) fail('automatic_run_timeout')
    const finalAccount = await api(accountRoute)
    evidence.successful_requests_after = finalAccount.successful_requests
    evidence.successful_request_delta = finalAccount.successful_requests - account.successful_requests
    evidence.reason = run.reason
    evidence.status = run.status
    evidence.error_code = run.error?.code || null
    evidence.finished_samples = run.samples?.length || 0
    evidence.used_outputs = run.result?.used_outputs || 0
    evidence.prediction = run.result?.prediction || null
    evidence.expected_candidate = run.result?.expected_candidate || null
    evidence.probability = run.result?.confidence ?? null
    evidence.applied_action = run.applied_action
    evidence.duration_ms = run.duration_ms
    evidence.bank_revision = run.bank_revision
    evidence.trigger_verified = run.account_id === accountId && run.reason === 'requests' && run.model === model &&
      evidence.successful_request_delta === 1
    evidence.samples = (run.samples || []).map(sample => ({ challenge_id: sample.challenge_id, sha256: sample.sha256,
      length: sample.length, usage: numericUsage(sample.usage) }))
    evidence.chain_verified = run.account_id === accountId && run.reason === 'requests' && run.model === model &&
      run.samples?.length === 3 && run.result?.used_outputs === 3 && run.applied_action === 'none' &&
      ['match', 'suspected_mismatch', 'inconclusive'].includes(run.status) &&
      run.bank_revision === summary.bank.revision && evidence.successful_request_delta === 1
    if (!evidence.chain_verified) fail('automatic_chain_verification_failed')
  }
} catch (error) {
  evidence.failure_code = error.safeCode || 'transport_or_runtime_failed'
  process.exitCode = 1
} finally {
  if (keyCreationAttempted && panel?.sessionToken) {
    try {
      // If creation committed but its response was lost, locate only this
      // acceptance's unique name; never remove another user's key.
      if (!keyId) {
        const listed = await panelApi('/api/panel/api-keys')
        const matches = (listed.keys || []).filter(item => item.name === keyName)
        if (matches.length > 1) fail('temporary_key_cleanup_ambiguous')
        keyId = matches[0]?.id || null
      }
      if (keyId) await panelApi(`/api/panel/api-keys/${encodeURIComponent(keyId)}`, { method: 'DELETE' })
      evidence.temporary_key.deleted = true
    } catch {
      evidence.cleanup_failure = 'temporary_key_cleanup_failed'
      process.exitCode = 1
    }
  }
  if (policyChanged && originalPolicy) {
    try {
      if (evidence.chain_verified && !evidence.cleanup_failure) {
        await api(policyRoute, 'PUT', {
          enabled: true, trigger: 'requests', every_requests: 10, action: 'observe', sample_count: 3,
          model: originalPolicy.effective_config.model, model_mode: originalPolicy.effective_config.model_mode,
        })
        const policy = await api(policyRoute)
        evidence.final_policy = {
          enabled: policy.effective_config.enabled, trigger: policy.effective_config.trigger,
          every_requests: policy.effective_config.every_requests, action: policy.effective_config.action,
          sample_count: policy.effective_config.sample_count, model: policy.effective_config.model,
          automation_ready: policy.automation?.ready === true,
        }
        evidence.verified = evidence.final_policy.enabled === true && evidence.final_policy.trigger === 'requests' &&
          evidence.final_policy.every_requests === 10 && evidence.final_policy.action === 'observe' &&
          evidence.final_policy.sample_count === 3 && evidence.final_policy.automation_ready
        if (!evidence.verified) fail('final_automatic_policy_invalid')
      } else {
        // The user's HTTP response can be lost after VM2 has already emitted a
        // successful-usage event. Discover only this acceptance's new task;
        // never resubmit inference to find out whether the first call ran.
        if (!runId && evidence.provider_inference_requested && evidence.submitted_at) {
          try {
            const history = await api(runsRoute)
            const candidates = history.items.filter(item => !beforeRunIds.has(item.id) &&
              item.reason === 'requests' && item.model === observedModel &&
              Date.parse(item.created_at) >= Date.parse(evidence.submitted_at))
            if (candidates.length === 1) {
              runId = candidates[0].id
              evidence.run_id = runId
              evidence.status = candidates[0].status
            } else if (candidates.length > 1) evidence.automatic_run_cleanup_unresolved = true
            evidence.automatic_run_cleanup_checked = true
          } catch { evidence.automatic_run_cleanup_unresolved = true }
        }
        if (runId && ['queued', 'running'].includes(evidence.status)) {
          await api(`/modeltrace/runs/${encodeURIComponent(runId)}/cancel`, 'POST', {})
          evidence.automatic_run_cancel_requested = true
        }
        await restorePolicy()
      }
    } catch {
      evidence.policy_failure = 'policy_finalize_failed'
      evidence.verified = false
      process.exitCode = 1
      try { await restorePolicy() } catch { evidence.policy_restore_failed = true }
    }
  }
  if (panel?.sessionToken) {
    try {
      await panelApi('/api/panel/logout', { method: 'POST', body: {} })
      evidence.panel_session_closed = true
    } catch {
      evidence.session_cleanup_failed = true
      evidence.verified = false
      process.exitCode = 1
    }
  }
  if (panel) { panel.password = ''; panel.sessionToken = ''; panel.cookie = ''; panel.controlToken = '' }
  managementToken = null
  temporaryKey = null
  originalPolicy = null
  evidence.finished_at = new Date().toISOString()
  await save()
  console.log(JSON.stringify({ ...evidence, evidence_file: output }, null, 2))
}
