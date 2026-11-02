import crypto from 'node:crypto'
import { isValidVmId } from '../vm/vm-file.mjs'
import { isHealthRealBypass } from '../admin/health-probe.mjs'

const modelName = /^[a-z0-9][a-z0-9._:/-]{0,149}$/i

// Only completed, authenticated inference is eligible. Never forward prompts,
// responses, headers, API keys, credentials, or upstream error text.
export function integrationUsageEvent(req, res, context, bag) {
  return integrationUsageDecision(req, res, context, bag).event
}

export function integrationUsageDecision(req, res, context, bag) {
  const skip = reason => ({ event: null, reason })
  if (!['master', 'managed'].includes(req.apiKeyKind)) return skip('unauthenticated')
  if (req.apiKeyKind === 'master' &&
      req.headers?.['x-es2api-modeltrace'] === '1') return skip('internal_modeltrace')
  if (req.apiKeyKind === 'master' && isHealthRealBypass(req.headers)) return skip('internal_health')
  if (!Number.isInteger(res.statusCode) || res.statusCode < 200 || res.statusCode >= 300) return skip('http_not_success')
  if (bag.final_state !== 'verified') return skip('terminal_not_verified')
  if (bag.error_code) return skip('protocol_error')
  if (bag.inference_completed === false) return skip('inference_not_completed')
  if (!isValidVmId(bag.vm_id)) return skip('slot_missing')
  const model = bag.requested_model || bag.model
  const upstream = bag.upstream_model || model
  const id = context.request_id
  if (!modelName.test(model || '') || !modelName.test(upstream || '')) return skip('model_invalid')
  if (typeof id !== 'string' || !/^[a-z0-9._:-]{1,200}$/i.test(id)) return skip('event_id_invalid')
  return { event: { event_id: id, source: 'vm2', vm_id: bag.vm_id, model, upstream_model: upstream, success: true }, reason: null }
}

export function attachIntegrationUsage(req, res, context, bag, reporter) {
  if (!reporter?.enabled) return
  // requestLog may accept a caller-provided x-request-id. Use an independent
  // server id so repeated/invalid client ids cannot suppress successful usage.
  const eventContext = { request_id: crypto.randomUUID() }
  res.once('finish', () => {
    try {
      const { event, reason } = integrationUsageDecision(req, res, eventContext, bag)
      if (event) reporter.publish(event)
      else reporter.skip?.(reason)
    } catch {
      reporter.skip?.('observer_error')
      // Telemetry must not alter the completed client response.
    }
  })
}

// The queue is deliberately bounded and does not retain user content. Transient
// retries resend only the same idempotent event, never the inference request.
export function createIntegrationUsageReporter({
  mode = process.env.ES2API_USAGE_MODE || 'push',
  db,
  getDb = () => db,
  url = process.env.ES2API_USAGE_URL || '',
  token = process.env.ES2API_USAGE_TOKEN || '',
  fetchImpl = globalThis.fetch,
  capacity = 256,
  outboxCapacity = 50000,
  timeoutMs = 1500,
  maxAttempts = 3,
  retryDelayMs = 100,
  warn = message => console.warn(message),
} = {}) {
  const selectedMode = mode === 'pull' ? 'pull' : 'push'
  let endpoint = null
  try {
    const parsed = new URL(url)
    if (['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password && token.length >= 32) endpoint = parsed.href
  } catch {}
  const queue = []
  const counters = { accepted: 0, delivered: 0, failed: 0, dropped: 0 }
  const skipped = {}
  let outboxDb = null
  let configurationError = null
  function outbox() {
    const current = getDb()
    if (!current?.prepare || !current?.exec) throw new Error('usage_outbox_db_unavailable')
    if (current !== outboxDb) {
      current.exec(`CREATE TABLE IF NOT EXISTS integration_usage_outbox (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        payload TEXT NOT NULL
      )`)
      outboxDb = current
    }
    return current
  }
  if (selectedMode === 'pull') {
    try { outbox() } catch { configurationError = 'usage_outbox_db_unavailable' }
  }
  const enabled = selectedMode === 'pull' ? !configurationError : !!endpoint
  let draining = null
  let lastWarning = 0
  const warning = () => {
    if (Date.now() - lastWarning < 60_000) return
    lastWarning = Date.now()
    warn('[es2api-usage] Usage delivery failed or queue is full; some automatic detection counters may be delayed or missing')
  }

  async function send(event) {
    const body = JSON.stringify(event)
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      let retryable = true
      try {
        const response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body,
          redirect: 'error',
          signal: AbortSignal.timeout(timeoutMs),
        })
        await response.body?.cancel?.()
        if (response.ok) return true
        retryable = response.status >= 500 || response.status === 429
      } catch {}
      if (!retryable) return false
      if (attempt + 1 < maxAttempts) await new Promise(resolve => setTimeout(resolve, retryDelayMs * 2 ** attempt))
    }
    return false
  }

  async function drain() {
    // Defer all I/O until the finish listener has returned.
    await new Promise(resolve => setImmediate(resolve))
    while (queue.length) {
      const event = queue[0]
      if (await send(event)) counters.delivered++
      else { counters.failed++; warning() }
      queue.shift()
    }
    draining = null
  }

  return {
    enabled,
    skip(reason) {
      const allowed = ['unauthenticated', 'internal_modeltrace', 'internal_health', 'http_not_success',
        'terminal_not_verified', 'protocol_error', 'inference_not_completed', 'slot_missing', 'model_invalid',
        'event_id_invalid', 'observer_error']
      if (allowed.includes(reason)) skipped[reason] = (skipped[reason] || 0) + 1
    },
    publish(event) {
      if (!enabled) return false
      if (selectedMode === 'pull') {
        try {
          const current = outbox()
          if (current.prepare('SELECT 1 FROM integration_usage_outbox WHERE event_id=?').get(event.event_id)) return true
          if (current.prepare('SELECT COUNT(*) AS count FROM integration_usage_outbox').get().count >= outboxCapacity) {
            counters.dropped++; warning(); return false
          }
          const payload = { event_id: event.event_id, source: 'vm2', vm_id: event.vm_id, model: event.model,
            upstream_model: event.upstream_model, success: event.success === true }
          current.prepare('INSERT INTO integration_usage_outbox(event_id,created_at,payload) VALUES(?,?,?)')
            .run(event.event_id, new Date().toISOString(), JSON.stringify(payload))
          counters.accepted++
          return true
        } catch { counters.failed++; warning(); return false }
      }
      if (queue.length >= capacity) { counters.dropped++; warning(); return false }
      queue.push(event)
      counters.accepted++
      if (!draining) draining = drain()
      return true
    },
    pending(limit = 100) {
      if (selectedMode !== 'pull' || !enabled) return []
      const size = Number.isInteger(limit) ? Math.max(1, Math.min(500, limit)) : 100
      return outbox().prepare('SELECT payload FROM integration_usage_outbox ORDER BY seq LIMIT ?').all(size)
        .map(row => JSON.parse(row.payload))
    },
    ack(eventIds) {
      if (selectedMode !== 'pull' || !enabled) return 0
      if (!Array.isArray(eventIds) || eventIds.length > 500 ||
          eventIds.some(id => typeof id !== 'string' || !/^[a-z0-9._:-]{1,200}$/i.test(id))) {
        throw Object.assign(new Error('invalid_usage_ack'), { code: 'invalid_usage_ack' })
      }
      const ids = [...new Set(eventIds)]
      if (!ids.length) return 0
      const result = outbox().prepare(`DELETE FROM integration_usage_outbox WHERE event_id IN (${ids.map(() => '?').join(',')})`).run(...ids)
      counters.delivered += Number(result.changes)
      return Number(result.changes)
    },
    snapshot() {
      let pending = queue.length
      if (selectedMode === 'pull' && enabled) pending = outbox().prepare('SELECT COUNT(*) AS count FROM integration_usage_outbox').get().count
      return { ...counters, pending, enabled, mode: selectedMode, skipped: { ...skipped }, configuration_error: configurationError }
    },
    async flush() { if (draining) await draining },
  }
}
