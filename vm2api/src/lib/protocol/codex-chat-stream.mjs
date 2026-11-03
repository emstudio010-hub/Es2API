import crypto from 'node:crypto'
import { codexBodyToChatCompletion } from './codex-chat-response.mjs'
import { extractOpenaiUsage, openaiChatUsageFromExtract } from './openai-usage.mjs'

export function isCodexChatStreamError(error) {
  return ['codex_chat_stream_invalid', 'codex_chat_stream_mismatch', 'codex_chat_stream_unsupported', 'codex_chat_stream_failed', 'codex_chat_stream_incomplete'].includes(error?.code)
}

export function createCodexChatStream({ id, model = '' } = {}) {
  const streamId = id && id !== 'codex' ? id : `chatcmpl_${crypto.randomUUID()}`
  const created = Math.floor(Date.now() / 1000), limit = 10 * 1024 * 1024
  let finished = false, complete = false, started = false, responseId = null, chunkModel = model, size = 0, seq = 0
  let emittedText = '', emittedRefusal = ''
  const items = new Map(), parts = new Map(), tools = new Map()
  const fail = (code = 'codex_chat_stream_invalid', usage = null) => {
    finished = true
    const error = new Error(code === 'codex_chat_stream_unsupported'
      ? 'This output cannot be represented by streaming Chat; use non-streaming Chat or Responses'
      : 'Upstream Chat stream did not complete consistently')
    error.code = code
    if (usage) error.usage = usage
    throw error
  }
  const grow = text => { size += text.length; if (size > limit) fail() }
  const chunk = (delta, finish = null, usage = null) => {
    if (typeof chunkModel !== 'string' || !chunkModel) fail()
    const payload = { id: streamId, object: 'chat.completion.chunk', created, model: chunkModel,
      choices: [{ index: 0, delta: started ? delta : { role: 'assistant', ...delta }, logprobs: null, finish_reason: finish }] }
    started = true
    if (usage) payload.usage = usage
    return `data: ${JSON.stringify(payload)}\n\n`
  }
  const itemAt = (index, type, itemId) => {
    if (!Number.isSafeInteger(index) || index < 0 || (itemId != null && (typeof itemId !== 'string' || !itemId))) fail()
    let item = items.get(index)
    if (!item) {
      if (items.size >= 4096) fail()
      item = { type, id: itemId || null }; items.set(index, item)
    }
    if (item.type !== type || (itemId && item.id && item.id !== itemId)) fail('codex_chat_stream_mismatch')
    if (itemId) item.id = itemId
    return item
  }
  const textPart = (index, contentIndex, kind, value, full, itemId) => {
    itemAt(index, 'message', itemId)
    if (!Number.isSafeInteger(contentIndex) || contentIndex < 0 || typeof value !== 'string') fail()
    const key = `${index}:${contentIndex}`
    let part = parts.get(key)
    if (!part) {
      if (parts.size >= 8192) fail()
      part = { kind, value: '' }; parts.set(key, part)
    }
    if (part.kind !== kind || (full && !value.startsWith(part.value))) fail('codex_chat_stream_mismatch')
    const delta = full ? value.slice(part.value.length) : value
    grow(delta); part.value += delta
    if (!delta) return ''
    if (kind === 'refusal') emittedRefusal += delta
    else emittedText += delta
    return chunk({ [kind === 'refusal' ? 'refusal' : 'content']: delta })
  }
  const fullPart = (index, contentIndex, part, itemId) => {
    if (part?.type === 'refusal') return textPart(index, contentIndex, 'refusal', part.refusal, true, itemId)
    if (!['output_text', 'text'].includes(part?.type)) fail('codex_chat_stream_unsupported')
    if (part.annotations?.length || part.logprobs?.length) fail('codex_chat_stream_unsupported')
    return textPart(index, contentIndex, 'text', part.text, true, itemId)
  }
  const toolAt = (index, itemId, callId, name) => {
    itemAt(index, 'function_call', itemId)
    let slot = tools.get(index)
    if (!slot) { slot = { index: seq++, id: null, name: null, value: '', emitted: 0, header: false }; tools.set(index, slot) }
    for (const [key, value] of [['id', callId], ['name', name]]) {
      if (value == null) continue
      if (typeof value !== 'string' || !value || (slot[key] && slot[key] !== value)) fail('codex_chat_stream_mismatch')
      slot[key] = value
    }
    return slot
  }
  const toolValue = (slot, value, full) => {
    if (typeof value !== 'string' || (full && !value.startsWith(slot.value))) fail('codex_chat_stream_mismatch')
    const delta = full ? value.slice(slot.value.length) : value
    grow(delta); slot.value += delta
    if (!slot.id || !slot.name) return '' // Buffer deltas until a usable tool header arrives.
    const calls = []
    if (!slot.header) {
      if ([...tools.values()].some(other => other !== slot && other.id === slot.id)) fail('codex_chat_stream_mismatch')
      calls.push({ index: slot.index, id: slot.id, type: 'function', function: { name: slot.name, arguments: '' } })
      slot.header = true
    }
    const pending = slot.value.slice(slot.emitted)
    if (pending) calls.push({ index: slot.index, function: { arguments: pending } })
    slot.emitted = slot.value.length
    return calls.length ? chunk({ tool_calls: calls }) : ''
  }
  const fullItem = (index, item) => {
    if (item?.type === 'reasoning') { itemAt(index, 'reasoning', item.id); return '' }
    if (item?.type === 'custom_tool_call') fail('codex_chat_stream_unsupported')
    if (item?.type === 'function_call') return toolValue(toolAt(index, item.id, item.call_id, item.name), item.arguments, true)
    if (item?.type !== 'message') fail('codex_chat_stream_unsupported')
    itemAt(index, 'message', item.id)
    if (item.role !== 'assistant' || !Array.isArray(item.content)) fail()
    return item.content.map((part, contentIndex) => fullPart(index, contentIndex, part, item.id)).join('')
  }
  const terminal = response => {
    let converted
    try { converted = codexBodyToChatCompletion(response, chunkModel) }
    catch (error) {
      if (error?.code === 'codex_chat_output_unsupported') fail('codex_chat_stream_unsupported')
      fail()
    }
    if (converted.choices[0].message.tool_calls?.some(tool => tool.type !== 'function') || converted.choices[0].message.annotations?.length) fail('codex_chat_stream_unsupported')
    const frames = response.output.map((item, index) => fullItem(index, item)).join('')
    for (const [index] of items) if (!response.output[index]) fail('codex_chat_stream_mismatch')
    for (const [key] of parts) {
      const [index, contentIndex] = key.split(':').map(Number)
      if (!response.output[index]?.content?.[contentIndex]) fail('codex_chat_stream_mismatch')
    }
    if (emittedText !== (converted.choices[0].message.content || '') || emittedRefusal !== (converted.choices[0].message.refusal || '')) fail('codex_chat_stream_mismatch')
    const finishReason = converted.choices[0].finish_reason
    const end = chunk({}, finishReason, converted.usage)
    finished = true; complete = response.status === 'completed'
    return `${frames}${end}data: [DONE]\n\n`
  }
  return {
    push(line) {
      if (finished) return null
      const raw = String(line ?? '')
      if (raw.length > limit) fail()
      const data = raw.split(/\r?\n/).filter(part => part.startsWith('data:')).map(part => part.slice(5).replace(/^ /, '')).join('\n')
      if (!data.trim()) return null
      if (data.trim() === '[DONE]') fail('codex_chat_stream_incomplete')
      let event
      try { event = JSON.parse(data) } catch { fail() }
      if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.type !== 'string') fail()
      const response = event.response
      if (response?.id) {
        if (typeof response.id !== 'string' || (responseId && responseId !== response.id)) fail('codex_chat_stream_mismatch')
        responseId = response.id
      }
      if (response?.model) {
        if (typeof response.model !== 'string' || (started && response.model !== chunkModel)) fail('codex_chat_stream_mismatch')
        if (!started) chunkModel = response.model
      }
      const type = event.type
      const partial = type === 'response.incomplete' && response?.status === 'incomplete' && ['max_output_tokens', 'content_filter'].includes(response.incomplete_details?.reason)
      if (event.error || response?.error || ['response.failed', 'response.cancelled', 'response.canceled', 'error'].includes(type) ||
          (['failed', 'cancelled', 'canceled', 'incomplete'].includes(response?.status) && !partial)) {
        fail('codex_chat_stream_failed', openaiChatUsageFromExtract(extractOpenaiUsage(response?.usage || event.usage)))
      }
      if (['response.completed', 'response.done'].includes(type) || partial) return terminal(response)
      if (type.startsWith('response.custom_tool_call')) fail('codex_chat_stream_unsupported')
      if (type === 'response.output_item.added' || type === 'response.output_item.done') return fullItem(event.output_index, event.item)
      if (type === 'response.content_part.added' || type === 'response.content_part.done') return fullPart(event.output_index, event.content_index, event.part, event.item_id)
      if (type === 'response.output_text.delta' || type === 'response.refusal.delta') return textPart(event.output_index, event.content_index, type === 'response.refusal.delta' ? 'refusal' : 'text', event.delta, false, event.item_id)
      if (type === 'response.output_text.done' || type === 'response.refusal.done') return textPart(event.output_index, event.content_index, type === 'response.refusal.done' ? 'refusal' : 'text', event.refusal ?? event.text, true, event.item_id)
      if (type === 'response.function_call_arguments.delta' || type === 'response.function_call_arguments.done') return toolValue(toolAt(event.output_index, event.item_id, null, event.name), event.arguments ?? event.delta, type.endsWith('.done'))
      if (type === 'response.output_text.annotation.added') fail('codex_chat_stream_unsupported')
      // Reasoning/progress metadata is not public assistant content. Unknown
      // visible deltas must never be copied into content by a generic fallback.
      if (type.startsWith('response.reasoning_') || ['response.created', 'response.in_progress', 'response.queued'].includes(type)) return null
      if (type.endsWith('.delta') || type.endsWith('.done')) fail('codex_chat_stream_unsupported')
      return null
    },
    end() { if (!finished) fail('codex_chat_stream_incomplete') },
    get finished() { return finished },
    get complete() { return complete },
  }
}

export function finishChatSse(state) {
  if (state?.chatStream) return state.chatStream.end()
  const error = new Error('Upstream Chat stream did not emit a terminal response')
  error.code = 'codex_chat_stream_incomplete'
  throw error
}
