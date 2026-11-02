import crypto from 'node:crypto'
import WebSocket, { WebSocketServer } from 'ws'

export function isolatedUpgrade({ accountPool, store, secret, baseUrl, apiKey, isolation, gatewayToken, equalSecret }) {
  const server = new WebSocketServer({ noServer: true, maxPayload: 10 * 1024 * 1024, perMessageDeflate: false })
  const connections = new Set()
  const upgrade = (req, socket, head) => {
    const route = new URL(req.url || '/', 'http://localhost').pathname.match(/^\/gateway\/([a-zA-Z0-9._:-]{1,160})\/v1\/responses$/)
    const reject = status => { socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`) }
    if (!route || req.method !== 'GET' || !apiKey) return reject('404 Not Found')
    if (!equalSecret(String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i)?.[1], gatewayToken(secret, route[1]))) return reject('401 Unauthorized')
    const group = store.getGroup(route[1])
    if (!group || group.status !== 'active' || (group.strategy === 'per_slot' && !group.lease_account_id)) return reject('503 Service Unavailable')
    try { isolation.context(req, group.id) } catch { return reject('401 Unauthorized') }
    server.handleUpgrade(req, socket, head, downstream => {
      connections.add(downstream)
      let upstream, lease, context, closed = false, busy = false
      const fallback = crypto.randomUUID()
      const deadline = setTimeout(() => stop(1008), 15000)
      deadline.unref()
      const idle = setInterval(() => { if (Date.now() - lastActivity > 15 * 60 * 1000) stop(1001) }, 30000)
      idle.unref()
      let lastActivity = Date.now()
      const stop = (code = 1011) => {
        if (closed) return
        closed = true; clearTimeout(deadline); clearInterval(idle); connections.delete(downstream)
        // Terminate upstream before releasing its lease; no slot remains in use.
        upstream?.terminate()
        if (downstream.readyState === WebSocket.OPEN) downstream.close(code, 'Execution connection closed')
        else downstream.terminate()
        if (lease) {
          try { accountPool.releaseRequest(lease.request_id, { success: false }) }
          catch { console.error('[es2api] websocket lease release failed') }
        }
      }
      const send = (target, data, done = () => {}) => {
        if (target.readyState !== WebSocket.OPEN || target.bufferedAmount > 8 * 1024 * 1024) { stop(); return }
        target.send(data, { binary: false }, error => { if (error) stop(); else done() })
      }
      downstream.on('error', () => stop())
      downstream.on('close', () => stop(1000))
      downstream.on('message', (bytes, binary) => {
        lastActivity = Date.now()
        if (closed || binary || busy) { stop(1008); return }
        let body
        try { body = JSON.parse(bytes.toString()); if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error() }
        catch { stop(1008); return }
        if (body.type !== 'response.create') {
          if (!upstream || body.type !== 'response.cancel') { stop(1008); return }
          try {
            if (body.response_id) {
              const cancelContext = isolation.context(req, group.id, { previous_response_id: body.response_id }, fallback)
              const owner = isolation.lookup(cancelContext, 'response', cancelContext.previous)
              if (!owner) throw new Error()
              isolation.assertAccount(lease.account, owner)
            }
            send(upstream, bytes)
          } catch { stop(1008) }
          return
        }
        try {
          const next = isolation.context(req, group.id, body, fallback)
          if (context) {
            const previous = next.previous ? isolation.lookup(next, 'response', next.previous) : null
            if ((next.previous && !previous) || context.session !== next.session) throw new Error()
            isolation.assertAccount(store.getAccount(lease.account.id), previous || {
              account_id: lease.account.id, vm_id: lease.account.vm_id, generation: lease.account.provision_generation })
            if (previous && previous.account_id !== lease.account.id) throw new Error()
            isolation.assertReferences(next, lease.account)
            const current = store.getAccount(lease.account.id)
            if (store.getGroup(group.id)?.status !== 'active' || !current.schedulable || current.status !== 'ready' || !current.group_ids.includes(group.id)) throw new Error()
          } else {
            if (typeof body.model !== 'string' || !body.model) throw new Error()
            context = next; lease = isolation.select(context, group, accountPool)
          }
          const payload = JSON.stringify(isolation.upstreamBody(context, lease.account, body))
          isolation.remember(context, 'session', context.session, lease.account)
          if (upstream) { send(upstream, payload); return }
          busy = true
          const target = new URL('/v1/responses', baseUrl)
          target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:'
          const headers = { authorization: `Bearer ${apiKey}`, 'x-kin-vm': lease.account.vm_id,
            ...isolation.upstreamHeaders(context, lease.account) }
          for (const key of ['priority', 'fast', 'ultrafast', 'openai-beta']) if (typeof req.headers[key] === 'string') headers[key] = req.headers[key]
          upstream = new WebSocket(target, { headers, handshakeTimeout: 15000, maxPayload: 10 * 1024 * 1024, perMessageDeflate: false, followRedirects: false })
          upstream.on('error', () => stop())
          upstream.on('close', () => stop(1000))
          upstream.on('open', () => { clearTimeout(deadline); send(upstream, payload, () => { busy = false }) })
          upstream.on('message', (data, isBinary) => {
            lastActivity = Date.now()
            if (isBinary) { stop(1008); return }
            try { isolation.observe(context, lease.account, JSON.parse(data.toString())) }
            catch { stop(); return }
            send(downstream, data)
          })
        } catch {
          if (downstream.readyState === WebSocket.OPEN) downstream.send(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', code: 'session_isolation_conflict', message: 'Cannot continue on the original execution slot; start a new session.' } }))
          stop(1008)
        }
      })
    })
  }
  upgrade.close = () => { for (const ws of connections) ws.terminate(); server.close() }
  return upgrade
}
