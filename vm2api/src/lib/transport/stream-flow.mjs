import { StringDecoder } from 'node:string_decoder'

export const STREAM_LINE_BYTES = 8 * 1024 * 1024
export const STREAM_BODY_BYTES = 64 * 1024 * 1024
export const STREAM_MAX_LINES = 262144
export const STREAM_PENDING_BYTES = 1024 * 1024
export const DOWNSTREAM_DRAIN_MS = 30000

const FLOW_CODES = new Set(['stream_line_limit', 'stream_buffer_limit', 'downstream_backpressure_timeout', 'downstream_write_failed', 'downstream_closed'])
export const isStreamFlowError = error => FLOW_CODES.has(error?.code)
const flowError = (code, status = 502) => Object.assign(new Error(code), { code, status })
const aborted = signal => {
  if (signal?.aborted) throw Object.assign(new Error('Request cancelled'), { code: 'client_cancelled', status: 499 })
}

/** Bound retained lines by bytes and count, including empty/comment frames. */
export function createSseBuffer({ maxBytes = STREAM_BODY_BYTES, maxLines = STREAM_MAX_LINES } = {}) {
  let lines = [], bytes = 0
  return {
    push(line) {
      const text = String(line)
      const size = Buffer.byteLength(text) + 1
      if (size > maxBytes - bytes || lines.length >= maxLines) throw flowError('stream_buffer_limit')
      lines.push(text); bytes += size
    },
    take() { const result = lines; lines = []; bytes = 0; return result },
  }
}

/** Await the consumer, preserve split UTF8, and bound every line and hop. */
export async function readSseLines(stream, onLine, { signal, maxLineBytes = STREAM_LINE_BYTES, maxBytes = STREAM_BODY_BYTES, maxLines = STREAM_MAX_LINES, onChunk } = {}) {
  const decoder = new StringDecoder('utf8')
  let pending = '', lineBytes = 0, bytes = 0, count = 0
  const append = text => {
    lineBytes += Buffer.byteLength(text)
    if (lineBytes > maxLineBytes) throw flowError('stream_line_limit')
    pending += text
  }
  const consume = async text => {
    let start = 0, end
    while ((end = text.indexOf('\n', start)) >= 0) {
      append(text.slice(start, end))
      if (++count > maxLines) throw flowError('stream_buffer_limit')
      aborted(signal)
      await onLine(pending.replace(/\r$/, ''))
      pending = ''; lineBytes = 0; start = end + 1
    }
    append(text.slice(start))
  }
  for await (const value of stream) {
    aborted(signal)
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
    bytes += chunk.length
    if (bytes > maxBytes) throw flowError('stream_buffer_limit')
    onChunk?.()
    await consume(decoder.write(chunk))
  }
  await consume(decoder.end())
  if (pending) {
    if (++count > maxLines) throw flowError('stream_buffer_limit')
    aborted(signal)
    await onLine(pending.replace(/\r$/, ''))
  }
}

/** One awaited write; no extra output queue. Close/abort/error bound drain waits. */
export async function writeDownstream(res, chunk, { signal, timeoutMs = DOWNSTREAM_DRAIN_MS } = {}) {
  aborted(signal)
  if (res.destroyed || res.writableEnded) throw flowError('downstream_closed')
  const deadline = Date.now() + Math.max(1, Number(timeoutMs) || DOWNSTREAM_DRAIN_MS)
  const drain = () => new Promise((resolve, reject) => {
    let timer
    const cleanup = () => {
      clearTimeout(timer)
      res.off('drain', drained); res.off('close', closed); res.off('error', failed)
      signal?.removeEventListener('abort', cancelled)
    }
    const finish = error => { cleanup(); error ? reject(error) : resolve() }
    const drained = () => finish()
    const closed = () => finish(flowError('downstream_closed'))
    const failed = () => finish(flowError('downstream_write_failed'))
    const cancelled = () => finish(Object.assign(new Error('Request cancelled'), { code: 'client_cancelled', status: 499 }))
    res.once('drain', drained); res.once('close', closed); res.once('error', failed)
    signal?.addEventListener('abort', cancelled, { once: true })
    timer = setTimeout(() => finish(flowError('downstream_backpressure_timeout', 504)), Math.max(1, deadline - Date.now()))
    timer.unref?.()
    if (signal?.aborted) cancelled()
    else if (res.destroyed || res.writableEnded) closed()
    else if (!res.writableNeedDrain) drained()
  })
  if (res.writableNeedDrain) await drain()
  aborted(signal)
  if (res.destroyed || res.writableEnded) throw flowError('downstream_closed')
  let accepted
  try { accepted = res.write(chunk) }
  catch { throw flowError('downstream_write_failed') }
  if (!accepted) await drain()
}
