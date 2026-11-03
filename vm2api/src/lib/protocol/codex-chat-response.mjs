import { extractOpenaiUsage, openaiChatUsageFromExtract } from './openai-usage.mjs'

export function isCodexChatResponseError(error) {
  return error?.code === 'codex_chat_response_invalid' || error?.code === 'codex_chat_output_unsupported'
}

function reject(unsupported = false) {
  const error = new Error(unsupported
    ? 'Codex output cannot be represented by Chat Completions; use the Responses endpoint'
    : 'Codex returned an invalid or unfinished Chat response')
  error.code = unsupported ? 'codex_chat_output_unsupported' : 'codex_chat_response_invalid'
  throw error
}

// Shared by Kernel and CLI. Reasoning items remain outside the public assistant
// message; unsupported visible outputs must not disappear during conversion.
export function codexBodyToChatCompletion(body = {}, model = '') {
  const response = body?.response && typeof body.response === 'object' ? body.response : body
  if (!response || response.error || typeof response.id !== 'string' || !response.id || !Array.isArray(response.output)) reject()
  let finishReason
  if (response.status === 'completed') finishReason = 'stop'
  else if (response.status === 'incomplete' && response.incomplete_details?.reason === 'max_output_tokens') finishReason = 'length'
  else if (response.status === 'incomplete' && response.incomplete_details?.reason === 'content_filter') finishReason = 'content_filter'
  else reject()

  const text = [], refusals = [], tools = [], annotations = [], callIds = new Set()
  let textLength = 0
  for (const item of response.output) {
    if (!item || typeof item !== 'object') reject()
    if (response.status === 'completed' && item.status && item.status !== 'completed') reject()
    if (item.type === 'reasoning') continue
    if (item.type === 'function_call' || item.type === 'custom_tool_call') {
      if (typeof item.call_id !== 'string' || !item.call_id || callIds.has(item.call_id) || typeof item.name !== 'string' || !item.name) reject()
      callIds.add(item.call_id)
      if (item.type === 'function_call') {
        // Arguments are model-generated JSON text. Preserve it byte for byte,
        // including truncated arguments when the upstream reports a length stop.
        if (typeof item.arguments !== 'string') reject()
        tools.push({ id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments } })
      } else {
        if (typeof item.input !== 'string') reject()
        tools.push({ id: item.call_id, type: 'custom', custom: { name: item.name, input: item.input } })
      }
      continue
    }
    if (item.type !== 'message') reject(true)
    if (item.role !== 'assistant' || !Array.isArray(item.content)) reject()
    for (const part of item.content) {
      if (part?.type === 'refusal') {
        if (typeof part.refusal !== 'string') reject()
        refusals.push(part.refusal)
        continue
      }
      if (!['output_text', 'text'].includes(part?.type)) reject(true)
      if (typeof part.text !== 'string') reject()
      if (part.logprobs?.length) reject(true)
      if (part.annotations != null && !Array.isArray(part.annotations)) reject()
      for (const annotation of part.annotations || []) {
        if (annotation?.type !== 'url_citation') reject(true)
        const { start_index: start, end_index: end, title, url } = annotation
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > part.text.length || typeof title !== 'string' || typeof url !== 'string') reject()
        annotations.push({ type: 'url_citation', url_citation: { start_index: textLength + start, end_index: textLength + end, title, url } })
      }
      text.push(part.text)
      textLength += part.text.length
    }
  }
  if (finishReason === 'stop' && tools.length) finishReason = 'tool_calls'
  const message = { role: 'assistant', content: text.length ? text.join('') : null, refusal: refusals.length ? refusals.join('') : null }
  if (tools.length) message.tool_calls = tools
  if (annotations.length) message.annotations = annotations
  return {
    id: response.id, object: 'chat.completion',
    created: Number.isSafeInteger(response.created_at) && response.created_at >= 0 ? response.created_at : Math.floor(Date.now() / 1000),
    model: response.model || model,
    choices: [{ index: 0, message, logprobs: null, finish_reason: finishReason }],
    usage: openaiChatUsageFromExtract(extractOpenaiUsage(response.usage)),
    ...(typeof response.service_tier === 'string' ? { service_tier: response.service_tier } : {}),
  }
}
