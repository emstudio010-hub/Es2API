// Bounded protocol observation; no inference retry, response storage or text log.
export function createGatewayCompletionObserver({ contentType = '', endpoint = 'responses', expectedChoices = 1, observe = () => {} } = {}) {
  const sse = contentType.toLowerCase().includes('text/event-stream')
  const chat = endpoint === 'chat/completions'
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const limit = 10 * 1024 * 1024
  let pending = '', frame = [], frameSize = 0, failed = false, invalid = false, terminal = false, done = false, ended = false
  const choices = new Map()
  const count = Number.isSafeInteger(expectedChoices) && expectedChoices > 0 ? expectedChoices : 1
  const id = value => typeof value === 'string' && value.length > 0 && value.length <= 512
  const parse = text => {
    if (!text.trim()) return
    if (text.trim() === '[DONE]') { if (done) invalid = true; done = true; return }
    let payload
    try { payload = JSON.parse(text) } catch { invalid = true; return }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || done) { invalid = true; return }
    observe(payload)
    const response = payload.response || payload
    if (payload.error || response.error || ['error', 'response.failed', 'response.incomplete', 'response.cancelled', 'response.canceled'].includes(payload.type) ||
        ['failed', 'incomplete', 'cancelled', 'canceled'].includes(response.status)) { failed = true; return }
    // Chat endpoints must return Chat payloads even if the upstream execution
    // originally used Responses. Conversion belongs to the execution layer.
    if (chat) {
      if (!['chat.completion', 'chat.completion.chunk'].includes(payload.object) || !id(payload.id) || !Array.isArray(payload.choices)) { invalid = true; return }
      for (const choice of payload.choices) {
        if (!Number.isSafeInteger(choice?.index) || choice.index < 0 || choice.index >= count) { invalid = true; continue }
        if (!choices.has(choice.index)) choices.set(choice.index, false)
        if (choice.finish_reason != null) {
          if (!['stop', 'length', 'tool_calls', 'function_call', 'content_filter'].includes(choice.finish_reason)) invalid = true
          else choices.set(choice.index, true)
        }
      }
      terminal = choices.size === count && [...choices.values()].every(Boolean)
      return
    }
    if (payload.type === 'response.completed' || response.object === 'response') {
      if (response.status === 'completed' && id(response.id) && Array.isArray(response.output)) terminal = true
      else if (payload.type === 'response.completed') invalid = true
    }
    if (!sse && endpoint === 'responses/compact' && response.object === 'response.compaction' && id(response.id) && Array.isArray(response.output)) terminal = true
  }
  const line = text => {
    if (!text) {
      if (frame.length) parse(frame.join('\n'))
      frame = []; frameSize = 0
    } else if (text.startsWith('data:')) {
      const data = text.slice(5).replace(/^ /, '')
      frameSize += data.length
      if (frameSize > limit) { invalid = true; frame = [] }
      else frame.push(data)
    }
  }
  const consume = text => {
    pending += text
    if (!sse) {
      if (pending.length > limit) { invalid = true; pending = '' }
      return
    }
    let index
    while ((index = pending.indexOf('\n')) >= 0) {
      const part = pending.slice(0, index).replace(/\r$/, '')
      pending = pending.slice(index + 1)
      line(part)
      if (invalid) { pending = ''; frame = []; return }
    }
    if (pending.length > limit) { invalid = true; pending = '' }
  }
  return {
    push(chunk) {
      if (ended) { invalid = true; return }
      if (invalid) return
      let text
      try { text = decoder.decode(chunk, { stream: true }) } catch { invalid = true; return }
      consume(text)
    },
    end() {
      if (ended) return
      ended = true
      if (invalid) { pending = ''; frame = []; return }
      let tail
      try { tail = decoder.decode() } catch { invalid = true; pending = ''; frame = []; return }
      consume(tail)
      // SSE frames require a terminating blank line. Do not promote a truncated
      // final line/frame to a complete event just because the socket ended.
      if (sse) { if (pending || frame.length) invalid = true }
      else parse(pending)
      pending = ''; frame = []
    },
    get completed() { return ended && terminal && !failed && !invalid && (!sse || !chat || done) },
    get rejected() { return ended && failed && !invalid },
  }
}
