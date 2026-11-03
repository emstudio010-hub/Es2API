import { VM2_PROTOCOL_PATHS, buildCodexImportRequest, buildVmProvisionRequest, normalizeVmStatus } from './contract.mjs'
import { parseTraceResponse, readTraceBody, traceError, traceTransportError } from './trace-response.mjs'

function joinUrl(base, path) {
  return `${String(base).replace(/\/$/, '')}${path}`
}

function responseError(status, payload) {
  const error = new Error(payload?.error?.message || payload?.message || `VM2 request failed (${status})`)
  error.code = payload?.error?.code || `vm2_http_${status}`
  error.status = status
  return error
}

async function readJson(response) {
  const text = await response.text()
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    return { raw: text.slice(0, 256) }
  }
}

export function vm2LifecycleTimeout(value) {
  const timeout = value === undefined || value === '' ? 360_000 : Number(value)
  if (!Number.isInteger(timeout) || timeout < 15_000 || timeout > 900_000) {
    throw new TypeError('VM2API_LIFECYCLE_TIMEOUT_MS must be an integer from 15000 to 900000')
  }
  return timeout
}

export class Vm2Client {
  constructor({ baseUrl, username, password, controlToken, fetchImpl = globalThis.fetch, timeoutMs = 15_000, lifecycleTimeoutMs = 360_000 } = {}) {
    if (!baseUrl) throw new TypeError('baseUrl is required')
    if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl is required')
    this.baseUrl = String(baseUrl).replace(/\/$/, '')
    this.username = username || ''
    this.password = password || ''
    this.controlToken = controlToken || ''
    this.fetchImpl = fetchImpl
    this.timeoutMs = timeoutMs
    this.lifecycleTimeoutMs = vm2LifecycleTimeout(lifecycleTimeoutMs)
    this.sessionToken = ''
    this.cookie = ''
    this.loginPromise = null
  }

  async request(path, { method = 'GET', body, idempotencyKey, retryAuthentication = true, timeoutMs = this.timeoutMs } = {}) {
    const headers = { accept: 'application/json' }
    if (body !== undefined) headers['content-type'] = 'application/json'
    if (this.sessionToken) headers.authorization = `Bearer ${this.sessionToken}`
    else if (this.controlToken) headers.authorization = `Bearer ${this.controlToken}`
    if (this.cookie) headers.cookie = this.cookie
    if (idempotencyKey) headers['idempotency-key'] = String(idempotencyKey)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await this.fetchImpl(joinUrl(this.baseUrl, path), {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      })
      const payload = await readJson(response)
      if (response.status === 401 && retryAuthentication && path !== VM2_PROTOCOL_PATHS.login && this.username && this.password) {
        // VM2 rejects authentication before dispatching lifecycle writes. Retry
        // only this case, never transport errors, forbidden calls, or inference.
        const currentToken = this.sessionToken || this.controlToken
        if (!this.sessionToken || headers.authorization === `Bearer ${currentToken}`) {
          this.sessionToken = ''
          this.cookie = ''
          await this.login()
        }
        return this.request(path, { method, body, idempotencyKey, retryAuthentication: false, timeoutMs })
      }
      const setCookie = response.headers?.get?.('set-cookie')
      if (setCookie) this.cookie = setCookie.split(';', 1)[0]
      if (!response.ok) throw responseError(response.status, payload)
      return payload
    } finally {
      clearTimeout(timer)
    }
  }

  async login() {
    if (this.sessionToken) return this.sessionToken
    if (this.loginPromise) return this.loginPromise
    if (!this.username || !this.password) {
      if (this.controlToken) return this.controlToken
      throw new Error('VM2 panel credentials are required')
    }
    this.loginPromise = (async () => {
      const payload = await this.request(VM2_PROTOCOL_PATHS.login, {
        method: 'POST',
        body: { username: this.username, password: this.password },
        retryAuthentication: false,
      })
      this.sessionToken = String(payload.token || '')
      if (!this.sessionToken) throw new Error('VM2 login did not return a session token')
      return this.sessionToken
    })()
    try { return await this.loginPromise } finally { this.loginPromise = null }
  }

  async ensureSession() {
    if (!this.sessionToken && !this.controlToken) await this.login()
  }

  async createSlot(binding, idempotencyKey) {
    await this.ensureSession()
    return this.request(VM2_PROTOCOL_PATHS.create, {
      method: 'POST',
      body: buildVmProvisionRequest(binding),
      idempotencyKey,
      timeoutMs: this.lifecycleTimeoutMs,
    })
  }

  async importCredential(vmId, credential, idempotencyKey) {
    await this.ensureSession()
    return this.request(VM2_PROTOCOL_PATHS.import, {
      method: 'POST',
      body: buildCodexImportRequest(vmId, credential),
      idempotencyKey,
      timeoutMs: this.lifecycleTimeoutMs,
    })
  }

  async ensureSlotProxy(vmId) {
    await this.ensureSession()
    try {
      return await this.request(`/api/panel/vms/${encodeURIComponent(vmId)}/allocate-proxy`, { method: 'POST', body: {}, timeoutMs: this.lifecycleTimeoutMs })
    } catch (error) {
      if (error.status === 409) throw Object.assign(new Error('没有可用的独占出口，请先导入未占用的 IP 资源，再重试该账号。已有固定出口不会自动更换。'), { status: 409, code: 'dedicated_proxy_unavailable' })
      throw error
    }
  }

  async listExitResources() {
    await this.ensureSession()
    const payload = await this.request('/api/panel/proxies')
    const rows = (payload.data || payload).proxies || []
    // Allowlist fields: never return URLs, raw imports, passwords or probe errors.
    return rows.filter(p => p.kind !== 'local' && !String(p.id).startsWith('px-local')).map(p => ({
      id: p.id, label: p.label || '', host: p.host, port: p.port, status: p.status, enabled: p.enabled,
      bound_vm_ids: p.bound_vm_ids || (p.bound_vm_id ? [p.bound_vm_id] : []),
      available: p.enabled && !['dead', 'fail'].includes(p.status) && !p.blocked_reason && !(p.bound_count || p.bound_vm_id || p.bound_vm_ids?.length) && !p.owner_user_id,
      timezone: p.geo?.timezone || null,
    }))
  }

  async importExitResources(text) {
    await this.ensureSession()
    const payload = await this.request('/api/panel/proxies/import', { method: 'POST', body: { text } })
    const result = payload.data || payload
    return { added: Number(result.added || 0), skipped: Number(result.skipped || 0) }
  }

  async startSlot(vmId, idempotencyKey) {
    await this.ensureSession()
    const payload = await this.request(VM2_PROTOCOL_PATHS.start(vmId), { method: 'POST', body: {}, idempotencyKey, timeoutMs: this.lifecycleTimeoutMs })
    const startError = payload?.start_error || payload?.data?.start_error
    if (startError) throw Object.assign(new Error(String(startError).slice(0, 500)), { code: 'vm2_start_failed', status: 502 })
    return payload
  }

  async stopSlot(vmId, idempotencyKey) {
    await this.ensureSession()
    return this.request(VM2_PROTOCOL_PATHS.stop(vmId), { method: 'POST', body: {}, idempotencyKey, timeoutMs: this.lifecycleTimeoutMs })
  }

  async recoverSlot(vmId, idempotencyKey) {
    await this.ensureSession()
    const payload = await this.request(`/api/panel/vms/${encodeURIComponent(vmId)}/recover`, { method: 'POST', body: {}, idempotencyKey, timeoutMs: this.lifecycleTimeoutMs })
    const report = payload.data || payload
    if (report.ok !== true) throw Object.assign(new Error('实例恢复未完成，请同步状态后检查运行环境'), { status: 502, code: 'vm2_recovery_incomplete' })
    return payload
  }

  async getSlot(vmId) {
    await this.ensureSession()
    const payload = await this.request(VM2_PROTOCOL_PATHS.status(vmId))
    return normalizeVmStatus(payload)
  }

  async deleteSlot(vmId, idempotencyKey) {
    await this.ensureSession()
    try { await this.getSlot(vmId) } catch (error) {
      if (error.status === 404) return { ok: true, already_absent: true }
      throw error
    }
    try { await this.stopSlot(vmId, `${idempotencyKey}:stop`) } catch (error) {
      if (error.status !== 404) throw error
    }
    try {
      await this.request(VM2_PROTOCOL_PATHS.delete(vmId), { method: 'DELETE', idempotencyKey, timeoutMs: this.lifecycleTimeoutMs })
    } catch (error) {
      if (error.status !== 404) throw error
    }
    try {
      await this.getSlot(vmId)
    } catch (error) {
      if (error.status === 404) return { ok: true, absence_confirmed: true }
      throw error
    }
    throw Object.assign(new Error('VM2 槽位删除尚未确认，仍可读取到该槽位'), { status: 502, code: 'slot_delete_unconfirmed' })
  }
}

function responseText(payload) {
  if (typeof payload?.output_text === 'string') return payload.output_text
  const parts = []
  for (const item of payload?.output || []) {
    for (const content of item?.content || []) if (content?.type === 'output_text' && typeof content.text === 'string') parts.push(content.text)
  }
  if (parts.length) return parts.join('')
  return ''
}

/** Executes a bounded trace challenge through the bound VM2 slot. */
export function createVm2TraceRunner({ baseUrl, apiKey, fetchImpl = globalThis.fetch } = {}) {
  if (!baseUrl || !apiKey) throw new TypeError('VM2 inference base URL and API key are required')
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl is required')
  const origin = String(baseUrl).replace(/\/$/, '')
  return async ({ account, model, challenge, signal, timeout_ms = 90000 }) => {
    if (!account?.vm_id) throw new Error('account has no bound VM2 slot')
    const timeout = AbortSignal.timeout(timeout_ms)
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
    let response
    try {
      response = await fetchImpl(`${origin}/v1/responses`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'x-kin-vm': account.vm_id,
          'x-es2api-modeltrace': '1',
        },
        body: JSON.stringify({ model, input: challenge.prompt, stream: false, store: false,
          ...(challenge.instructions ? { instructions: challenge.instructions } : {}) }),
        signal: combined,
      })
    } catch (error) { throw traceTransportError(error, { signal, timeout }) }
    if (!response.ok) {
      // Do not read or retain an untrusted provider error body.
      void response.body?.cancel().catch(() => {})
      throw traceError('trace_upstream_error', { status: response.status, http_status: response.status })
    }
    let body
    try { body = await readTraceBody(response) } catch (error) {
      if (error?.code === 'trace_response_too_large') throw error
      throw traceTransportError(error, { signal, timeout, httpStatus: response.status })
    }
    const payload = parseTraceResponse(body, response.status)
    const text = responseText(payload)
    if (!text.trim()) throw traceError('trace_empty_output', { http_status: response.status, response_state: 'completed' })
    return { text, usage: payload?.usage || null }
  }
}
