import crypto from 'node:crypto'
import { once } from 'node:events'
import { GatewayIsolation, responseObserver } from './gateway-isolation.mjs'
import { isolatedUpgrade } from './gateway-websocket.mjs'
import { createGatewayTransport, GATEWAY_TIMEOUT_MS } from './gateway-transport.mjs'

export function gatewayToken(secret, groupId) {
  return crypto.createHmac('sha256', secret).update(`es2api-gateway-v1:${groupId}`).digest('hex')
}

function forwardingHeaders(req) {
  const headers = {}
  for (const key of ['priority', 'fast', 'ultrafast', 'openai-beta', 'session_id', 'conversation_id', 'x-session-id']) {
    const value = req.headers[key]
    if (typeof value === 'string') headers[key] = value
  }
  return headers
}

export function createPoolUpgrade(options) {
  return isolatedUpgrade({ ...options, isolation: options.isolation || new GatewayIsolation(options.store), gatewayToken, equalSecret })
}

function equalSecret(a, b) {
  const left = Buffer.from(String(a || '')), right = Buffer.from(b)
  return left.length === right.length && crypto.timingSafeEqual(left, right)
}
function fail(res, status, code, message) {
  if (res.destroyed || res.writableFinished) return
  if (res.writableEnded || res.headersSent) { res.destroy(); return }
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify({ error: { type: code, code, message } }))
}

// Native Sub2API accounts call this private upstream after their own key, group,
// concurrency and billing gates. No user-supplied slot or master header survives.
export function createPoolGateway({ accountPool, store, secret, baseUrl, apiKey, maxBodyBytes = 10 * 1024 * 1024, isolation = new GatewayIsolation(store) }) {
  const origin = new URL(baseUrl)
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password) throw new Error('Invalid VM2 origin')
  const transport = createGatewayTransport()
  const handle = async (req, res, groupId, endpoint) => {
    const bearer = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i)?.[1]
    if (!equalSecret(bearer, gatewayToken(secret, groupId))) return fail(res, 401, 'authentication_error', 'Invalid execution credential')
    if (!(req.method === 'GET' && endpoint === 'models') && !(req.method === 'POST' && ['responses', 'responses/compact', 'chat/completions'].includes(endpoint))) return fail(res, 404, 'not_found', 'Unsupported execution endpoint')
    if (!apiKey) return fail(res, 503, 'gateway_unavailable', 'Execution service is not configured')
    const group = store.getGroup(groupId)
    if (!group || group.status !== 'active' || (group.strategy === 'per_slot' && !group.lease_account_id)) return fail(res, 503, 'pool_unavailable', 'Execution group is unavailable')
    if (endpoint === 'models') {
      try {
        const response = await fetch(new URL('/v1/models', origin), { headers: { authorization: `Bearer ${apiKey}` }, redirect: 'error', signal: AbortSignal.timeout(10000) })
        if (!response.ok) { await response.body?.cancel(); return fail(res, 503, 'models_unavailable', 'Model catalog is unavailable') }
        const data = await response.json()
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(data))
      } catch { fail(res, 503, 'models_unavailable', 'Model catalog is unavailable') }
      return
    }
    const controller = new AbortController()
    let clientDisconnected = false, timedOut = false
    const abort = () => { if (!res.writableFinished) { clientDisconnected = true; controller.abort() } }
    req.once('aborted', abort)
    res.once('close', abort)
    const timeout = setTimeout(() => { timedOut = true; controller.abort() }, GATEWAY_TIMEOUT_MS)
    timeout.unref()
    let lease, status = 0, delivered = false, failureCode = null
    try {
      const chunks = []; let size = 0
      for await (const chunk of req) {
        size += chunk.length
        if (size > maxBodyBytes) return fail(res, 413, 'invalid_request_error', 'Request body is too large')
        chunks.push(chunk)
      }
      const body = Buffer.concat(chunks)
      let parsed
      try { parsed = JSON.parse(body.toString('utf8')) } catch { return fail(res, 400, 'invalid_request_error', 'Invalid JSON') }
      if (!parsed || typeof parsed.model !== 'string') return fail(res, 400, 'invalid_request_error', 'model is required')
      if (req.aborted || res.destroyed || controller.signal.aborted) throw Object.assign(new Error('Client disconnected'), { status: 499 })
      const context = isolation.context(req, groupId, parsed)
      lease = isolation.select(context, group, accountPool)
      const isolatedBody = JSON.stringify(isolation.upstreamBody(context, lease.account, parsed))
      const upstream = await transport.fetch(new URL(`/v1/${endpoint}`, origin), {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { ...forwardingHeaders(req), authorization: `Bearer ${apiKey}`, 'content-type': 'application/json',
          accept: 'application/json, text/event-stream', 'x-kin-vm': lease.account.vm_id,
          'x-es2api-pool-gateway': '1', ...isolation.upstreamHeaders(context, lease.account) }, body: isolatedBody,
      })
      status = upstream.status
      res.writeHead(status, { 'content-type': upstream.headers.get('content-type') || 'application/json',
        'cache-control': 'no-store', 'x-accel-buffering': 'no' })
      const observer = responseObserver(isolation, context, lease.account, upstream.headers.get('content-type') || '', { endpoint, expectedChoices: parsed.n })
      for await (const chunk of upstream.body || []) {
        observer.push(chunk)
        if (!res.write(chunk)) await once(res, 'drain', { signal: controller.signal })
      }
      observer.end()
      if (upstream.ok && !observer.completed && !observer.rejected) throw Object.assign(new Error('Execution response did not complete'), { code: 'gateway_response_incomplete' })
      if (upstream.ok && observer.rejected) failureCode = 'gateway_response_failed'
      const finished = once(res, 'finish', { signal: controller.signal })
      res.end()
      await finished
      delivered = upstream.ok && observer.completed && !controller.signal.aborted && res.writableFinished
    } catch (error) {
      failureCode = clientDisconnected ? 'gateway_client_cancelled' : timedOut ? 'gateway_timeout' :
        error?.code === 'gateway_response_incomplete' ? 'gateway_response_incomplete' : `gateway_${status || 'transport'}`
      const statusCode = error?.status || (error?.code === 'pool_unavailable' ? 503 : clientDisconnected ? 499 : timedOut ? 504 : 502)
      fail(res, statusCode, ['pool_unavailable', 'session_isolation_conflict', 'caller_namespace_required', 'invalid_session_identity', 'session_registry_full'].includes(error?.code) ? error.code : 'upstream_error', 'Execution could not complete')
    } finally {
      clearTimeout(timeout); req.off('aborted', abort); res.off('close', abort)
      if (lease) { try { accountPool.releaseRequest(lease.request_id, { success: delivered,
        error_code: delivered ? null : failureCode || `gateway_${status || 'transport'}`,
        ...(status === 429 ? { rate_limited_until: new Date(Date.now() + 60000).toISOString() } : {}),
        ...(status >= 500 ? { overload_until: new Date(Date.now() + 15000).toISOString() } : {}) }) } catch { console.error('[es2api] gateway lease release failed') } }
    }
  }
  handle.close = () => transport.close()
  return handle
}
