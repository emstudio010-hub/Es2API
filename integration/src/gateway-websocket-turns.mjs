import crypto from 'node:crypto'
import WebSocket, { WebSocketServer } from 'ws'
import { createResponseTurnObserver } from './gateway-ws-turn.mjs'
import { createWebSocketSender, startWebSocketHeartbeat, WS_MESSAGE_BYTES } from '../../vm2api/src/lib/transport/websocket-flow.mjs'

export function isolatedUpgrade({ accountPool, store, secret, baseUrl, apiKey, isolation, gatewayToken, equalSecret }) {
  const server = new WebSocketServer({ noServer: true, maxPayload: WS_MESSAGE_BYTES, perMessageDeflate: false })
  const connections = new Map()
  const upgrade = (req, socket, head) => {
    const route = new URL(req.url || '/', 'http://localhost').pathname.match(/^\/gateway\/([a-zA-Z0-9._:-]{1,160})\/v1\/responses$/)
    const reject = status => { socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`) }
    if (!route || req.method !== 'GET' || !apiKey) return reject('404 Not Found')
    if (!equalSecret(String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i)?.[1], gatewayToken(secret, route[1]))) return reject('401 Unauthorized')
    const group = store.getGroup(route[1])
    if (!group || group.status !== 'active' || (group.strategy === 'per_slot' && !group.lease_account_id)) return reject('503 Service Unavailable')
    try { isolation.context(req, group.id) } catch { return reject('401 Unauthorized') }
    server.handleUpgrade(req, socket, head, downstream => {
      let upstream, pinnedAccount, context, turn = null, closed = false, connecting = false
      let downstreamSender, upstreamSender, stopDownHeartbeat, stopUpHeartbeat
      let lastActivity = Date.now()
      const fallback = crypto.randomUUID()
      const claimedIdentities = new Set()
      const release = outcome => {
        const current = turn
        if (!current) return
        turn = null; clearTimeout(current.timer); clearTimeout(current.cancelTimer)
        try { accountPool.releaseRequest(current.lease.request_id, outcome) }
        catch { console.error('[es2api] websocket lease release failed') }
      }
      const stop = (code = 1011, errorCode = 'gateway_ws_transport') => {
        if (closed) return
        closed = true; clearTimeout(deadline); clearInterval(idle); connections.delete(downstream)
        stopDownHeartbeat?.(); stopUpHeartbeat?.()
        downstreamSender?.close(); upstreamSender?.close()
        // Close the local execution transport before releasing the active lease.
        // Server-side cancellation confirmation remains an execution concern.
        upstream?.terminate()
        release({ success: false, error_code: errorCode })
        if (downstream.readyState === WebSocket.OPEN) downstream.close(code, 'Execution connection closed')
        else downstream.terminate()
        const forceClose = setTimeout(() => downstream.terminate(), 5000)
        forceClose.unref(); downstream.once('close', () => clearTimeout(forceClose))
      }
      const deadline = setTimeout(() => stop(1008, 'gateway_ws_handshake_timeout'), 15000)
      deadline.unref()
      const idle = setInterval(() => { if (Date.now() - lastActivity > 15 * 60 * 1000) stop(1001, 'gateway_ws_idle_timeout') }, 30000)
      idle.unref()
      connections.set(downstream, stop)
      downstreamSender = createWebSocketSender(downstream, {
        onFailure: error => stop(1011, `gateway_${error.code}`),
        onPressure: paused => {
          if (closed || upstream?.readyState !== WebSocket.OPEN) return
          if (paused) upstream.pause()
          else upstream.resume()
        },
      })
      stopDownHeartbeat = startWebSocketHeartbeat(downstream, {
        onFailure: () => stop(1001, 'gateway_ws_downstream_heartbeat_timeout'),
        isBackpressured: () => downstreamSender.pressured,
      })
      const send = (target, data, done = () => {}) => {
        if (closed || target?.readyState !== WebSocket.OPEN) { stop(); return false }
        const sender = target === downstream ? downstreamSender : upstreamSender
        if (!sender) { stop(); return false }
        return sender.send(data, error => { if (error) stop(1011, `gateway_${error.code}`); else if (!closed) done() })
      }
      const finishTurn = current => {
        if (closed || turn !== current || !current.terminal || current.pendingWrites) return
        // The execution adapter acknowledges interrupts before confirming exit.
        // End this connection instead of reusing it as if cancellation drained.
        if (current.cancelled) { stop(1000, 'gateway_ws_cancelled'); return }
        release(current.terminal)
      }
      const parse = bytes => {
        const payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Invalid JSON object')
        return payload
      }
      downstream.on('error', () => stop())
      downstream.on('close', () => stop(1000, 'gateway_ws_client_cancelled'))
      downstream.on('message', (bytes, binary) => {
        lastActivity = Date.now()
        if (closed || binary) { stop(1008, 'gateway_ws_protocol'); return }
        let body
        try { body = parse(bytes) } catch { stop(1008, 'gateway_ws_protocol'); return }
        if (body.type !== 'response.create') {
          if (!['response.cancel', 'response.interrupt'].includes(body.type) || !turn || !upstream || connecting || turn.terminal || turn.cancelled) { stop(1008, 'gateway_ws_protocol'); return }
          try {
            const target = body.response_id ?? body.previous_response_id
            if (body.response_id != null && body.previous_response_id != null && body.response_id !== body.previous_response_id) throw new Error('Conflicting cancellation target')
            if (target != null) {
              const cancelContext = isolation.context(req, group.id, { previous_response_id: target }, fallback)
              const owner = isolation.lookup(cancelContext, 'response', cancelContext.previous)
              if (!owner || target !== turn.observer.responseId) throw new Error('Invalid cancellation target')
              isolation.assertAccount(turn.lease.account, owner)
            }
            turn.cancelled = true
            turn.cancelTimer = setTimeout(() => stop(1000, 'gateway_ws_cancelled'), 10000)
            turn.cancelTimer.unref()
            // VM2 implements response.interrupt, not response.cancel.
            send(upstream, JSON.stringify({ type: 'response.interrupt', ...(target != null ? { response_id: target } : {}) }))
          } catch { stop(1008, 'session_isolation_conflict') }
          return
        }
        // Sequential turns re-enter capacity gates without changing the slot.
        if (turn || connecting) { stop(1008, 'gateway_ws_concurrent_turn'); return }
        try {
          if (typeof body.model !== 'string' || !body.model) throw new Error('model is required')
          const currentGroup = store.getGroup(group.id)
          if (!currentGroup || currentGroup.status !== 'active') throw new Error('Group unavailable')
          const next = isolation.context(req, group.id, body, fallback)
          if (context && context.session !== next.session) throw new Error('Session changed')
          const lease = isolation.select(next, currentGroup, accountPool, pinnedAccount)
          // Establish ownership before operations that can throw after acquire.
          turn = { lease, context: next, observer: createResponseTurnObserver({ claimIdentity: id => {
            const digest = crypto.createHash('sha256').update(id).digest('hex')
            if (claimedIdentities.has(digest) || claimedIdentities.size >= 4096) throw new Error('Response identity cannot be reused')
            isolation.claimResponse(next, lease.account, id)
            claimedIdentities.add(digest)
          } }), pendingWrites: 0, terminal: null, cancelled: false, timer: null, receivedBytes: 0, receivedMessages: 0 }
          const current = turn
          current.timer = setTimeout(() => stop(1001, 'gateway_ws_turn_timeout'), 15 * 60 * 1000)
          current.timer.unref()
          context = next; pinnedAccount ||= lease.account
          const payload = JSON.stringify(isolation.upstreamBody(next, lease.account, body))
          if (upstream) { send(upstream, payload); return }
          connecting = true
          const target = new URL('/v1/responses', baseUrl)
          target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:'
          const headers = { authorization: `Bearer ${apiKey}`, 'x-kin-vm': lease.account.vm_id,
            ...isolation.upstreamHeaders(next, lease.account) }
          for (const key of ['priority', 'fast', 'ultrafast', 'openai-beta']) if (typeof req.headers[key] === 'string') headers[key] = req.headers[key]
          upstream = new WebSocket(target, { headers, handshakeTimeout: 15000, maxPayload: WS_MESSAGE_BYTES, perMessageDeflate: false, followRedirects: false })
          upstreamSender = createWebSocketSender(upstream, { onFailure: error => stop(1011, `gateway_${error.code}`) })
          upstream.on('error', () => stop())
          upstream.on('close', () => stop(1000, 'gateway_ws_upstream_closed'))
          upstream.on('open', () => {
            if (closed) { upstream.terminate(); return }
            stopUpHeartbeat = startWebSocketHeartbeat(upstream, {
              onFailure: () => stop(1001, 'gateway_ws_upstream_heartbeat_timeout'),
              isBackpressured: () => upstreamSender.pressured,
            })
            if (downstreamSender.pressured) upstream.pause()
            clearTimeout(deadline); connecting = false; send(upstream, payload)
          })
          upstream.on('message', (data, isBinary) => {
            lastActivity = Date.now()
            const active = turn
            if (isBinary || !active) { stop(1008, 'gateway_ws_protocol'); return }
            active.receivedBytes += data.length
            if (active.receivedBytes > 64 * 1024 * 1024 || ++active.receivedMessages > 262144) { stop(1009, 'gateway_ws_response_limit'); return }
            try {
              const event = parse(data)
              active.terminal = active.observer.push(event)
              if (event.type === 'response.interrupt.accepted') {
                if (!active.cancelled) throw new Error('Unexpected interrupt acknowledgement')
                active.terminal = { success: false, error_code: 'gateway_ws_cancelled' }
              }
              isolation.observe(active.context, active.lease.account, event)
            } catch { stop(1008, 'gateway_ws_protocol'); return }
            active.pendingWrites++
            send(downstream, data, () => { active.pendingWrites--; finishTurn(active) })
          })
        } catch {
          if (downstream.readyState === WebSocket.OPEN) send(downstream, JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', code: 'session_isolation_conflict', message: 'Cannot continue on the original execution slot; start a new session.' } }))
          stop(1008, 'session_isolation_conflict')
        }
      })
    })
  }
  upgrade.close = () => { for (const stop of connections.values()) stop(1001, 'gateway_ws_shutdown'); server.close() }
  return upgrade
}
