import crypto from 'node:crypto'
import { selectOAuthCredential } from '../../vm2api/src/lib/oauth/credential-import.mjs'
import { publicCodexCliObservation } from '../../vm2api/src/lib/transport/codex-cli-observation.mjs'

export const ACCOUNT_MODES = Object.freeze({
  POOL: 'pool',
  LEASE: 'lease',
})

export const VM2_PROTOCOL_PATHS = Object.freeze({
  login: '/api/panel/login',
  create: '/api/panel/vms/create',
  import: '/api/panel/vms/import',
  start: (id) => `/api/panel/vms/${encodeURIComponent(id)}/start`,
  stop: (id) => `/api/panel/vms/${encodeURIComponent(id)}/stop`,
  status: (id) => `/api/panel/vms/${encodeURIComponent(id)}`,
  delete: (id) => `/api/panel/vms/${encodeURIComponent(id)}`,
})

export const OPENAI_CONTROL_FIELDS = Object.freeze(['priority', 'fast', 'ultrafast'])
const OPENAI_CONTROL_FIELD_SET = new Set(OPENAI_CONTROL_FIELDS)

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function nonEmptyString(value, field) {
  const text = String(value ?? '').trim()
  if (!text) throw new TypeError(`${field} is required`)
  return text
}

function optionalString(value) {
  const text = String(value ?? '').trim()
  return text || null
}

function optionalLimit(value, field, min, max) {
  if (value === null || value === undefined) return null
  if (!Number.isInteger(value) || value < min || value > max) {
    throw Object.assign(new TypeError(`${field} 必须为 ${min}–${max} 的整数`), { status: 400, code: 'invalid_field' })
  }
  return value
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).map((v) => String(v).trim()).filter(Boolean))]
}

/** Private credential normalization. Use publicCredentialStatus for API responses. */
export function normalizeOpenAICredential(input) {
  let source = input
  if (typeof input === 'string') {
    const text = input.trim()
    if (!text) throw new TypeError('credential is required')
    try {
      source = JSON.parse(text)
    } catch {
      source = { access_token: text }
    }
  }
  const selected = selectOAuthCredential(source)
  const tokens = selected?.tokens || {}
  if (tokens.api_key) {
    throw new TypeError('VM2 Codex 槽不支持 OpenAI API Key 导入；请提供 ChatGPT OAuth 凭据')
  }
  if (!tokens.access_token && !tokens.refresh_token) {
    throw new TypeError('VM2 Codex 槽需要 ChatGPT OAuth access_token 或 refresh_token；OpenAI API Key 不受此执行器支持')
  }
  return {
    access_token: tokens.access_token || null,
    refresh_token: tokens.refresh_token || null,
    id_token: tokens.id_token || null,
    api_key: tokens.api_key || null,
    ...selected.metadata,
  }
}

export function credentialFingerprint(credential) {
  const normalized = normalizeOpenAICredential(credential)
  const material = [normalized.access_token, normalized.refresh_token, normalized.id_token, normalized.api_key]
    .filter(Boolean)
    .join('\n')
  return crypto.createHash('sha256').update(material).digest('hex')
}

export function publicCredentialStatus(credential) {
  const normalized = normalizeOpenAICredential(credential)
  return {
    has_access_token: !!normalized.access_token,
    has_refresh_token: !!normalized.refresh_token,
    has_id_token: !!normalized.id_token,
    has_api_key: !!normalized.api_key,
    fingerprint: credentialFingerprint(normalized),
  }
}

/**
 * Normalize the control-plane account record. The group and proxy decisions are
 * explicit so the execution service never invents scheduling policy.
 */
export function normalizeAccountBinding(input = {}) {
  const source = asRecord(input)
  const accountId = nonEmptyString(source.account_id ?? source.id, 'account_id')
  if (!/^[a-z0-9][a-z0-9_-]{0,75}$/i.test(accountId) || accountId.toLowerCase().endsWith('-chat')) {
    throw Object.assign(new TypeError('account_id 需要为 1–76 位字母、数字、下划线或连字符，且不能以 -chat 结尾'), { status: 400, code: 'invalid_account_id' })
  }
  const mode = String(source.mode || ACCOUNT_MODES.POOL).trim().toLowerCase()
  if (!Object.values(ACCOUNT_MODES).includes(mode)) throw new TypeError('mode must be pool or lease')
  const groupId = optionalString(source.group_id ?? source.groupId)
  const groupIds = uniqueStrings(source.group_ids ?? source.groupIds)
  const explicitGroups = groupId ? [groupId, ...groupIds] : groupIds
  const backend = source.execution_backend || 'kernel'
  if (!['kernel', 'codex-cli'].includes(backend)) throw Object.assign(new TypeError('execution_backend 必须为 kernel 或 codex-cli'), { status: 400, code: 'invalid_execution_backend' })
  if (backend === 'codex-cli' && source.max_concurrency != null && source.max_concurrency !== 1) throw Object.assign(new TypeError('Codex CLI 每个账号仅支持一个并行执行'), { status: 400, code: 'codex_cli_concurrency' })
  return {
    account_id: accountId,
    name: optionalString(source.name) || accountId,
    mode,
    group_ids: [...new Set(explicitGroups)],
    group_strategy: mode === ACCOUNT_MODES.LEASE || source.group_strategy === 'per_slot' ? 'per_slot' : explicitGroups.length ? 'shared' : 'unassigned',
    proxy_id: optionalString(source.proxy_id ?? source.ip_id ?? source.ipId),
    ip_policy: 'fixed',
    ip_selection: 'create_only',
    identity_policy: 'ip_derived',
    execution_backend: backend,
    provision_generation: Number.isSafeInteger(source.provision_generation) && source.provision_generation > 0 ? source.provision_generation : 1,
    // The VM2 create route derives the effective timezone from the selected
    // egress. Keeping an old value here is only for migration/display; it is
    // never sent as the identity input for an ip_derived slot.
    timezone: optionalString(source.timezone),
    locale: optionalString(source.locale) || 'en_US.UTF-8',
    max_concurrency: optionalLimit(source.max_concurrency, 'max_concurrency', 1, 256),
    max_rpm: optionalLimit(source.max_rpm, 'max_rpm', 0, 1000000),
    max_sessions: optionalLimit(source.max_sessions, 'max_sessions', 0, 256),
  }
}

export function buildVmProvisionRequest(binding) {
  const normalized = normalizeAccountBinding(binding)
  const request = {
    id: `es2-${normalized.account_id}`,
    name: normalized.name,
    platform: 'openai',
    family: 'codex',
    kind: 'codex',
    codex_kernel: true,
    execution_backend: normalized.execution_backend,
    runtime_type: 'docker',
    // VM2 creates an empty slot first. Credentials are imported before the
    // explicit start action so an empty container is never admitted.
    start: false,
    auto_allocate_proxy: !normalized.proxy_id,
    proxy_id: normalized.proxy_id,
    ip_selection: normalized.ip_selection,
    identity_policy: normalized.identity_policy,
    locale: normalized.locale,
    max_concurrency: normalized.max_concurrency,
    max_rpm: normalized.max_rpm,
    max_sessions: normalized.max_sessions,
    slot_binding: {
      account_id: normalized.account_id,
      mode: normalized.mode,
      group_ids: normalized.group_ids,
      group_strategy: normalized.group_strategy,
      ip_policy: normalized.ip_policy,
      provision_generation: normalized.provision_generation,
    },
  }
  return Object.fromEntries(Object.entries(request).filter(([, value]) => value !== null && value !== undefined))
}

export function buildCodexImportRequest(vmId, credential, { ifMissing = false, binding = null } = {}) {
  const id = nonEmptyString(vmId, 'vm_id')
  const normalized = normalizeOpenAICredential(credential)
  return {
    vm_id: id,
    mode: 'oauth',
    auth_json: JSON.stringify(normalized),
    ...(ifMissing ? { if_missing: true, expected_binding: binding } : {}),
  }
}

export function extractControlFields(headers = {}, body = {}) {
  const headerValues = {}
  for (const [key, value] of Object.entries(asRecord(headers))) {
    const normalized = key.toLowerCase()
    if (OPENAI_CONTROL_FIELD_SET.has(normalized)) headerValues[key] = value
  }
  const bodyValues = {}
  for (const field of OPENAI_CONTROL_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(asRecord(body), field)) bodyValues[field] = body[field]
  }
  return { headers: headerValues, body: bodyValues }
}

/** Preserve the caller's control fields byte-for-byte while allowing other fields to be adapted. */
export function mergeControlFields(targetHeaders = {}, targetBody = {}, sourceHeaders = {}, sourceBody = {}) {
  const controls = extractControlFields(sourceHeaders, sourceBody)
  const headers = { ...asRecord(targetHeaders) }
  for (const [key, value] of Object.entries(controls.headers)) headers[key] = value
  const body = { ...asRecord(targetBody), ...controls.body }
  return { headers, body }
}

export function normalizeVmStatus(payload = {}) {
  const raw = asRecord(payload)
  const vm = asRecord(raw.vm ?? raw.data?.vm ?? raw.data)
  const id = optionalString(vm.id ?? raw.id)
  const status = optionalString(vm.status ?? raw.status) || 'unknown'
  const health = asRecord(vm.health ?? raw.health)
  const codexHealth = asRecord(raw.data?.kernel?.codex_health ?? raw.kernel?.codex_health)
  const healthOk = health.ok === false || codexHealth.reachable === false ? false
    : health.ok === true || codexHealth.reachable === true ? true : null
  const proxy = asRecord(vm.proxy ?? raw.proxy ?? raw.data?.proxy)
  const allocatedProxy = raw.allocated_proxy ?? raw.data?.allocated_proxy
  const refreshPending = vm.credential_refresh_pending === true
  const refreshState = !refreshPending ? 'none'
    : ['prepared', 'received', 'incomplete', 'unreadable'].includes(vm.credential_refresh_state) ? vm.credential_refresh_state : 'unknown'
  return {
    id,
    status,
    execution_backend: vm.execution_backend === 'codex-cli' ? 'codex-cli' : 'kernel',
    cli_execution: vm.execution_backend === 'codex-cli' ? publicCodexCliObservation(vm.cli_execution) : null,
    ready: status === 'running' && healthOk !== false && !refreshPending,
    credential_refresh_pending: refreshPending,
    credential_refresh_state: refreshState,
    credential_refresh_recovery_available: refreshPending && refreshState === 'received' && vm.credential_refresh_recovery_available === true,
    schedulable: vm.schedulable === true,
    isolation: {
      account_id: optionalString(vm.integration_binding?.account_id),
      generation: Number(vm.integration_binding?.provision_generation) || null,
      runtime_type: optionalString(vm.runtime?.type ?? vm.runtime_type),
      container: optionalString(vm.runtime?.container),
      identity_policy: optionalString(vm.identity_policy),
    },
    health: {
      // `null` means the VM2 endpoint did not report a health probe. It is
      // different from an explicit failed probe and must not make a running
      // slot look unhealthy during a control-plane sync.
      ok: healthOk,
      code: optionalString(health.code ?? codexHealth.error_code),
      checked_at: optionalString(health.checked_at),
    },
    egress: {
      bound: !!(proxy.id || proxy.proxy_id || allocatedProxy?.id),
      proxy_id: optionalString(proxy.id ?? proxy.proxy_id ?? allocatedProxy?.id),
      timezone: optionalString(vm.timezone ?? raw.timezone),
    },
  }
}

export function publicLifecycleResult({ accountId, vmId, phase, status, credential }) {
  return {
    account_id: String(accountId),
    vm_id: vmId ? String(vmId) : null,
    phase: String(phase),
    status: String(status),
    credential: credential ? publicCredentialStatus(credential) : null,
  }
}
