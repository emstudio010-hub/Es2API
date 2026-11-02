// One explicit-account production check; never imports credentials or retries inference.
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const args = process.argv.slice(2)
const allowed = args.every(arg => arg === '--execute-once' || arg.startsWith('--account=') || arg.startsWith('--run='))
const accountId = args.find(arg => arg.startsWith('--account='))?.slice(10)
let runId = args.find(arg => arg.startsWith('--run='))?.slice(6)
const execute = args.includes('--execute-once')
const evidence = { schemaVersion: 1, started_at: new Date().toISOString(), fixture: false,
  entry: 'integration-direct-management', account_id: accountId || null,
  submission_attempts: 0, automatic_resubmissions: 0, provider_inference_requested: false, verified: false }
const output = path.join(root, 'runtime/verification', `modeltrace-live-${Date.now()}.json`)
let key
async function api(route, method = 'GET', body) {
  const response = await fetch(`http://127.0.0.1:18084/api/v1/admin${route}`, {
    method, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000),
  })
  const payload = await response.json()
  if (!response.ok || payload.ok !== true) throw Object.assign(new Error(`Management HTTP ${response.status}`), { code: payload.error?.code || `http_${response.status}` })
  return payload.data
}
async function save() {
  await fs.mkdir(path.dirname(output), { recursive: true })
  await fs.writeFile(output, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 })
}
try {
  if (!allowed || !accountId || (runId && execute)) throw Object.assign(new Error('Use --account=ID [--execute-once | --run=ID]'), { code: 'invalid_arguments' })
  const secret = JSON.parse(await fs.readFile(path.join(root, 'runtime/local-secrets.json'), 'utf8'))
  key = secret.integration.managementToken
  const [account, summary, policy] = await Promise.all([
    api(`/accounts/${encodeURIComponent(accountId)}`), api('/modeltrace/summary'), api(`/accounts/${encodeURIComponent(accountId)}/modeltrace`),
  ])
  evidence.preflight = { readiness: policy.readiness, bank: { revision: summary.bank.revision,
    source: summary.bank.source, method: summary.bank.method, models: summary.bank.models.length },
    vm_id: account.vm_id, proxy_id: account.binding.proxy_id,
    action: policy.effective_config.action, automatic_enabled: policy.effective_config.enabled,
    model: policy.effective_config.model, samples: policy.effective_config.sample_count }
  if (!policy.readiness?.ready) throw Object.assign(new Error('ModelTrace prerequisites are not ready'), { code: 'trace_not_ready' })
  if (policy.effective_config.action !== 'observe' || policy.effective_config.enabled !== false || policy.effective_config.sample_count !== 3) {
    throw Object.assign(new Error('Real acceptance requires automatic monitoring disabled, observe action and 3 samples'), { code: 'acceptance_policy_required' })
  }
  if (execute) {
    evidence.submission_attempts = 1
    evidence.provider_inference_requested = true
    await save() // Record intent before sending; transport failures must not resubmit.
    const queued = await api('/modeltrace/run', 'POST', { account_id: accountId })
    runId = queued.id
    evidence.run_id = runId
    await save()
  }
  if (runId) {
    evidence.run_id = runId
    const deadline = Date.now() + 330000
    let run
    do {
      run = await api(`/modeltrace/runs/${encodeURIComponent(runId)}`)
      if (run.account_id !== accountId || run.model !== policy.effective_config.model) throw Object.assign(new Error('Run identity mismatch'), { code: 'run_identity_mismatch' })
      if (!['queued', 'running'].includes(run.status)) break
      await new Promise(resolve => setTimeout(resolve, 1500))
    } while (Date.now() < deadline)
    evidence.status = run.status
    evidence.finished_samples = run.samples?.length || 0
    evidence.used_outputs = run.result?.used_outputs || 0
    evidence.prediction = run.result?.prediction || null
    evidence.expected_candidate = run.result?.expected_candidate || null
    evidence.probability = run.result?.confidence ?? null
    evidence.applied_action = run.applied_action
    evidence.error_code = run.error?.code || null
    evidence.duration_ms = run.duration_ms
    evidence.bank_revision = run.bank_revision
    evidence.samples = run.samples || []
    evidence.verified = run.samples?.length === 3 && run.result?.used_outputs === 3 &&
      ['match', 'suspected_mismatch', 'inconclusive', 'unlisted_model'].includes(run.status) &&
      run.applied_action === 'none' && run.bank_revision === summary.bank.revision
    if (!evidence.verified) process.exitCode = 1
  } else evidence.preflight_verified = true
} catch (error) {
  evidence.failure_code = error.code || 'preflight_or_transport_failed'
  process.exitCode = 1
} finally {
  key = null
  evidence.finished_at = new Date().toISOString()
  await save()
  console.log(JSON.stringify({ ...evidence, evidence_file: output }, null, 2))
}
