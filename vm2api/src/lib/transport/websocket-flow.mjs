import crypto from 'node:crypto'

export const WS_MESSAGE_BYTES = 10 * 1024 * 1024
export const WS_PENDING_BYTES = 16 * 1024 * 1024
export const WS_PENDING_MESSAGES = 256
export const WS_PRESSURE_HIGH = 256 * 1024
export const WS_PRESSURE_LOW = 64 * 1024
export const WS_SEND_TIMEOUT_MS = 30000
const flowError = code => Object.assign(new Error(code), { code })

/** One active send, bounded retained frames, callbacks only after local write. */
export function createWebSocketSender(ws, { onFailure = () => {}, onPressure = () => {} } = {}) {
  let queue = [], bytes = 0, active = null, timer = null, stopped = false, pressured = false
  const idle = new Set()
  const pressure = () => {
    const next = pressured ? bytes > WS_PRESSURE_LOW : bytes >= WS_PRESSURE_HIGH
    if (next === pressured) return
    pressured = next; onPressure(next)
  }
  const notify = (entry, error) => { try { entry.done?.(error) } catch { fail(flowError('websocket_send_callback_failed')) } }
  const settleIdle = error => {
    for (const waiter of idle) error ? waiter.reject(error) : waiter.resolve()
    idle.clear()
  }
  const stop = (error = flowError('websocket_closed'), report = false) => {
    if (stopped) return
    stopped = true; clearTimeout(timer)
    ws.off('close', closed); ws.off('error', broken)
    const entries = [...(active ? [active] : []), ...queue]
    active = null; queue = []; bytes = 0
    settleIdle(error)
    // Do not resume a paused source while its connection is being stopped.
    for (const entry of entries) notify(entry, error)
    if (report) onFailure(error)
  }
  const fail = error => stop(error, true)
  const closed = () => fail(flowError('websocket_closed'))
  const broken = () => fail(flowError('websocket_send_failed'))
  ws.once('close', closed); ws.once('error', broken)
  const pump = () => {
    if (stopped || active || !queue.length) return
    const entry = active = queue.shift()
    const remaining = entry.deadline - Date.now()
    if (remaining <= 0) { fail(flowError('websocket_send_timeout')); return }
    timer = setTimeout(() => fail(flowError('websocket_send_timeout')), remaining)
    timer.unref?.()
    try {
      ws.send(entry.data, { binary: false, compress: false }, error => {
        if (stopped || active !== entry) return
        clearTimeout(timer)
        if (error) { fail(flowError('websocket_send_failed')); return }
        active = null; bytes -= entry.bytes
        pressure(); notify(entry)
        if (!active && !queue.length) settleIdle()
        pump()
      })
    } catch { fail(flowError('websocket_send_failed')) }
  }
  return {
    send(data, done) {
      if (stopped || ws.readyState !== 1) {
        const error = flowError('websocket_closed')
        if (!stopped) fail(error)
        notify({ done }, error); return false
      }
      const size = Buffer.isBuffer(data) ? data.length : Buffer.byteLength(String(data))
      if (size > WS_MESSAGE_BYTES || size + Math.max(bytes, ws.bufferedAmount || 0) > WS_PENDING_BYTES ||
          queue.length + (active ? 1 : 0) >= WS_PENDING_MESSAGES) {
        const error = flowError('websocket_send_limit')
        fail(error); notify({ done }, error); return false
      }
      bytes += size; queue.push({ data, done, bytes: size, deadline: Date.now() + WS_SEND_TIMEOUT_MS }); pressure(); pump()
      return !stopped
    },
    whenIdle() {
      if (stopped) return Promise.reject(flowError('websocket_closed'))
      if (!active && !queue.length) return Promise.resolve()
      return new Promise((resolve, reject) => idle.add({ resolve, reject }))
    },
    close: () => stop(),
    get pressured() { return pressured },
    get pendingBytes() { return bytes },
  }
}

/** Transport liveness only. A paused receiver is covered by send timeout. */
export function startWebSocketHeartbeat(ws, { onFailure = () => {}, isBackpressured = () => false } = {}) {
  let waiting = null, sentAt = 0, stopped = false, pingPending = false
  const close = () => {
    if (stopped) return
    stopped = true; clearInterval(timer)
    ws.off('pong', pong); ws.off('close', close); ws.off('error', close)
  }
  const fail = () => { close(); onFailure(flowError('websocket_heartbeat_timeout')) }
  const pong = data => { if (waiting && Buffer.isBuffer(data) && waiting.equals(data)) { waiting = null; pingPending = false } }
  const timer = setInterval(() => {
    if (stopped || ws.readyState !== 1) return
    // Pausing reads also pauses pong handling. Never misreport a slow reader
    // as dead; its bounded send operation supplies the failure deadline.
    if (ws.isPaused) { waiting = null; pingPending = false; return }
    if ((waiting || pingPending) && Date.now() - sentAt >= 45000) { fail(); return }
    if (waiting || pingPending || isBackpressured() || ws.bufferedAmount > WS_PRESSURE_HIGH) return
    waiting = crypto.randomBytes(8); sentAt = Date.now(); pingPending = true
    try { ws.ping(waiting, error => { pingPending = false; if (error && !stopped) fail() }) }
    catch { fail() }
  }, 15000)
  timer.unref?.()
  ws.on('pong', pong); ws.once('close', close); ws.once('error', close)
  return close
}
