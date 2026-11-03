// Keep raw provider errors, response bodies and connection URLs out of history.
const messages = Object.freeze({
  trace_failed: '检测执行失败，请检查实例状态后决定是否重新检测',
  trace_canceled: '检测已取消',
  trace_timeout: '当前样本超过检测时限，未自动重试',
  trace_connection_failed: '无法完成与执行服务的连接，未自动重试',
  trace_upstream_error: '执行服务返回 HTTP 错误，未自动重试',
  trace_invalid_response: '执行服务返回的响应格式无效',
  trace_response_too_large: '检测响应超过大小限制，已停止读取',
  trace_response_failed: '执行服务报告响应失败，未使用其中的文本',
  trace_response_incomplete: '执行响应尚未完整结束，未使用其中的文本',
  trace_response_refused: '模型拒绝了检测挑战，本次不生成归因结果',
  trace_empty_output: '执行响应没有有效文本',
  invalid_trace_sample: '检测样本为空或超过长度限制',
  trace_context_changed: '检测期间实例状态发生变化',
  trace_runner_unavailable: 'ModelTrace 执行器未配置',
})
const networkCodes = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN', 'ENOTFOUND', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET'])
const responseStates = new Set(['completed', 'failed', 'incomplete', 'in_progress', 'queued', 'cancelled', 'canceled'])

export function traceError(code, details = {}) {
  return Object.assign(new Error(messages[code] || messages.trace_failed), { code }, details)
}

export function publicTraceError(error, canceled = false) {
  const code = canceled ? 'trace_canceled' : Object.hasOwn(messages, error?.code) ? error.code : 'trace_failed'
  const result = { code, message: messages[code] }
  if (Number.isInteger(error?.http_status) && error.http_status >= 100 && error.http_status <= 599) result.http_status = error.http_status
  if (networkCodes.has(error?.network_code)) result.network_code = error.network_code
  if (responseStates.has(error?.response_state)) result.response_state = error.response_state
  return result
}

export function traceTransportError(error, { signal, timeout, httpStatus } = {}) {
  const details = Number.isInteger(httpStatus) ? { http_status: httpStatus } : {}
  if (signal?.aborted) return traceError('trace_canceled', details)
  if (timeout?.aborted) return traceError('trace_timeout', details)
  const networkCode = error?.cause?.code || error?.code
  return traceError('trace_connection_failed', { ...details, ...(networkCodes.has(networkCode) ? { network_code: networkCode } : {}) })
}

export async function readTraceBody(response, limit = 4 * 1024 * 1024) {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks = []
  let bytes = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > limit) {
        await reader.cancel().catch(() => {})
        throw traceError('trace_response_too_large', { http_status: response.status })
      }
      chunks.push(Buffer.from(value))
    }
  } finally { reader.releaseLock() }
  return Buffer.concat(chunks).toString('utf8')
}

function completedResponse(payload, httpStatus) {
  const details = { http_status: httpStatus, ...(responseStates.has(payload?.status) ? { response_state: payload.status } : {}) }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw traceError('trace_invalid_response', details)
  if (payload.error || payload.status === 'failed') throw traceError('trace_response_failed', details)
  if (payload.status !== 'completed') throw traceError('trace_response_incomplete', details)
  if (payload.output != null && !Array.isArray(payload.output)) throw traceError('trace_invalid_response', details)
  for (const item of payload.output || []) {
    if (!item || typeof item !== 'object') throw traceError('trace_invalid_response', details)
    if (item.status != null && item.status !== 'completed') throw traceError('trace_response_incomplete', details)
    if (item.content != null && !Array.isArray(item.content)) throw traceError('trace_invalid_response', details)
    if (item.content?.some(part => part?.type === 'refusal')) throw traceError('trace_response_refused', details)
  }
  return payload
}

export function parseTraceResponse(body, httpStatus) {
  let payload
  try { payload = JSON.parse(body) } catch {
    // SSE data may span multiple lines. A final completion event is required;
    // deltas, [DONE] alone, failed and incomplete events cannot supply a sample.
    let completed = false
    for (const frame of body.replace(/\r\n/g, '\n').split('\n\n')) {
      const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n')
      if (!data || data === '[DONE]') continue
      let event
      try { event = JSON.parse(data) } catch { throw traceError('trace_invalid_response', { http_status: httpStatus }) }
      if (!event || typeof event !== 'object' || Array.isArray(event)) throw traceError('trace_invalid_response', { http_status: httpStatus })
      if (completed) throw traceError('trace_invalid_response', { http_status: httpStatus })
      if (event.type === 'error' || event.type === 'response.failed') throw traceError('trace_response_failed', { http_status: httpStatus, response_state: 'failed' })
      if (event.type === 'response.incomplete') throw traceError('trace_response_incomplete', { http_status: httpStatus, response_state: 'incomplete' })
      if (event.type === 'response.completed') {
        completed = true
        payload = event.response
      }
    }
    if (!completed) throw traceError('trace_response_incomplete', { http_status: httpStatus })
  }
  return completedResponse(payload, httpStatus)
}
