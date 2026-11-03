// Chat and Responses use different custom-tool envelopes. Preserve their raw
// strings; parsing custom input as JSON changes the caller's tool contract.
const INPUT_CODES = new Set(['codex_chat_tool_invalid', 'codex_chat_tool_history_invalid', 'codex_chat_n_unsupported'])
export const isCodexChatInputError = error => INPUT_CODES.has(error?.code)
function invalid(code = 'codex_chat_tool_invalid') {
  throw Object.assign(new Error('Chat tool input cannot be represented as Responses'), { code })
}
const record = value => value && typeof value === 'object' && !Array.isArray(value)
const named = value => typeof value === 'string' && value.length > 0 && value.length <= 512

function textParts(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return content?.text || ''
  return content
    .map((part) => {
      if (typeof part === 'string') return part
      if (part?.type === 'text' || part?.type === 'input_text' || part?.type === 'output_text') return part.text || ''
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function imageUrlOf(part) {
  if (typeof part?.image_url === 'string') return part.image_url
  if (typeof part?.image_url?.url === 'string') return part.image_url.url
  if (typeof part?.url === 'string') return part.url
  return ''
}

function userContentParts(content) {
  if (typeof content === 'string') return content ? [{ type: 'input_text', text: content }] : []
  if (!Array.isArray(content)) {
    const text = content?.text || ''
    return text ? [{ type: 'input_text', text }] : []
  }
  const parts = []
  for (const part of content) {
    if (typeof part === 'string') {
      if (part) parts.push({ type: 'input_text', text: part })
      continue
    }
    if (!part || typeof part !== 'object') continue
    if (part.type === 'image_url' || part.type === 'image' || part.type === 'input_image') {
      const url = imageUrlOf(part)
      if (url) parts.push({ type: 'input_image', image_url: url })
      continue
    }
    const text = part.text || ''
    if (text) parts.push({ type: 'input_text', text })
  }
  return parts
}

function toolArguments(call) {
  const raw = call?.function?.arguments ?? call?.arguments ?? '{}'
  return typeof raw === 'string' ? raw : JSON.stringify(raw ?? {})
}

/** Chat message → Responses items. Tool-only assistant turns stay function_call items, not empty text. */
function chatMessageToItems(message, calls) {
  if (!message || typeof message !== 'object') return []
  if (message.role === 'tool') {
    const id = message.tool_call_id || message.id
    const origin = calls.get(id)
    if (message.tool_call_id != null && message.id != null && message.tool_call_id !== message.id) invalid('codex_chat_tool_history_invalid')
    if (!named(id) || !origin || origin.returned) invalid('codex_chat_tool_history_invalid')
    if (typeof message.content !== 'string' && (!Array.isArray(message.content) ||
      message.content.some(part => !record(part) || part.type !== 'text' || typeof part.text !== 'string'))) invalid('codex_chat_tool_history_invalid')
    const output = typeof message.content === 'string' ? message.content : message.content.map(part => part.text).join('\n')
    origin.returned = true
    return [
      {
        type: origin.type === 'custom' ? 'custom_tool_call_output' : 'function_call_output',
        call_id: id,
        output,
      },
    ]
  }
  if (message.role === 'assistant') {
    const items = []
    const text = textParts(message.content)
    if (message.refusal != null && typeof message.refusal !== 'string') invalid('codex_chat_tool_history_invalid')
    if (text || message.refusal) {
      items.push({
        type: 'message',
        role: 'assistant',
        content: [...(text ? [{ type: 'output_text', text }] : []), ...(message.refusal ? [{ type: 'refusal', refusal: message.refusal }] : [])],
      })
    }
    if (message.tool_calls != null && !Array.isArray(message.tool_calls)) invalid('codex_chat_tool_history_invalid')
    for (const call of message.tool_calls || []) {
      if (!record(call) || (call.type != null && !['function', 'custom'].includes(call.type))) invalid('codex_chat_tool_history_invalid')
      const type = call.type || 'function'
      if ((type === 'custom' && call.function != null) || (type === 'function' && call.custom != null)) invalid('codex_chat_tool_history_invalid')
      const name = type === 'custom' ? call.custom?.name : call.function?.name || call.name
      const id = call.id || call.call_id
      if (call.id != null && call.call_id != null && call.id !== call.call_id) invalid('codex_chat_tool_history_invalid')
      if (!named(name) || !named(id) || calls.has(id)) invalid('codex_chat_tool_history_invalid')
      if (type === 'custom' && typeof call.custom?.input !== 'string') invalid('codex_chat_tool_history_invalid')
      calls.set(id, { type, returned: false })
      items.push({
        type: type === 'custom' ? 'custom_tool_call' : 'function_call',
        call_id: id,
        name,
        ...(type === 'custom' ? { input: call.custom.input } : { arguments: toolArguments(call) }),
      })
    }
    return items
  }
  const role = message.role === 'system' || message.role === 'developer' ? 'developer' : 'user'
  const parts = userContentParts(message.content)
  if (!parts.length) return []
  return [{ type: 'message', role, content: parts }]
}

const RESPONSES_CHOICE_MODES = new Set(['none', 'auto', 'required'])

/** Responses requires tool_choice.name at the top level. Chat nests it under function.name. */
export function responsesToolChoice(choice) {
  if (choice == null || choice === false || choice === '') return undefined
  if (typeof choice === 'string') {
    const mode = choice.trim().toLowerCase()
    if (mode === 'any') return 'required'
    if (RESPONSES_CHOICE_MODES.has(mode)) return mode
    return undefined
  }
  if (typeof choice !== 'object' || Array.isArray(choice)) return undefined

  const type = String(choice.type || '').toLowerCase()
  const name = String(choice.name || choice.function?.name || choice.custom?.name || '').trim()

  if (type === 'none' || type === 'auto' || type === 'required') return type
  if (type === 'any') return 'required'

  if (type === 'allowed_tools') {
    const allowed = record(choice.allowed_tools) ? choice.allowed_tools : choice
    if (!Array.isArray(allowed.tools) || !allowed.tools.length || (allowed.mode != null && !['auto', 'required'].includes(allowed.mode))) invalid()
    const tools = allowed.tools
      .map((tool) => {
        if (!record(tool)) invalid()
        const toolName = String(tool.name || tool.function?.name || tool.custom?.name || '').trim()
        if (tool.type === 'custom') {
          if (!toolName) invalid()
          return { type: 'custom', name: toolName }
        }
        if (tool.type === 'function' || tool.function) {
          if (!toolName) invalid()
          return { type: 'function', name: toolName }
        }
        return tool
      })
    const mode = String(allowed.mode || 'auto').toLowerCase() === 'required' ? 'required' : 'auto'
    return tools.length ? { type: 'allowed_tools', mode, tools } : mode
  }

  if (type === 'function' || type === 'tool' || type === 'custom') {
    if (!name && type === 'custom') invalid()
    if (!name) return 'required'
    return { type: type === 'tool' ? 'function' : type, name }
  }

  if (type === 'mcp') {
    if (!choice.server_label) return name ? { type: 'function', name } : undefined
    const out = { type: 'mcp', server_label: choice.server_label }
    if (name) out.name = name
    return out
  }

  if (name && !choice.name) return { type: type || 'function', name }
  return choice
}

function customFormat(format) {
  if (format == null) return undefined
  if (!record(format)) invalid()
  if (format.type === 'text') return { type: 'text' }
  const grammar = format.grammar || format
  if (format.type !== 'grammar' || !record(grammar) || !['lark', 'regex'].includes(grammar.syntax) || typeof grammar.definition !== 'string') invalid()
  return { type: 'grammar', syntax: grammar.syntax, definition: grammar.definition }
}

function toolsToCodex(tools) {
  if (tools != null && !Array.isArray(tools)) invalid()
  if (!Array.isArray(tools) || !tools.length) return undefined
  return tools.map((tool) => {
    if (tool?.type === 'custom') {
      if (tool.function != null || (tool.custom != null && !record(tool.custom))) invalid()
      const custom = tool.custom || tool
      if (!named(custom.name) || (custom.description != null && typeof custom.description !== 'string')) invalid()
      const format = customFormat(custom.format)
      return { type: 'custom', name: custom.name, ...(custom.description != null ? { description: custom.description } : {}), ...(format ? { format } : {}) }
    }
    if (tool?.type === 'function' && tool.function) {
      return {
        type: 'function',
        name: tool.function.name,
        description: tool.function.description || '',
        parameters: tool.function.parameters || { type: 'object', properties: {} },
        ...(tool.function.strict != null ? { strict: tool.function.strict } : {}),
      }
    }
    if (tool?.name && (!tool.type || tool.type === 'function')) {
      return {
        type: 'function',
        name: tool.name,
        description: tool.description || '',
        parameters: tool.input_schema || tool.parameters || { type: 'object', properties: {} },
        ...(tool.strict != null ? { strict: tool.strict } : {}),
      }
    }
    return tool
  })
}

export function chatToCodexResponses(body = {}) {
  if (body.n != null && body.n !== 1) invalid('codex_chat_n_unsupported')
  const messages = Array.isArray(body.messages) ? body.messages : []
  const calls = new Map()
  const input = messages.flatMap(message => chatMessageToItems(message, calls))
  const out = {
    model: body.model,
    input,
    stream: body.stream !== false,
    store: false,
  }
  const tools = toolsToCodex(body.tools)
  if (tools) out.tools = tools
  const choice = responsesToolChoice(body.tool_choice)
  if (choice) out.tool_choice = choice
  if (body.reasoning) out.reasoning = body.reasoning
  if (body.reasoning_effort) out.reasoning_effort = body.reasoning_effort
  if (body.max_tokens != null || body.max_completion_tokens != null) {
    out.max_output_tokens = body.max_completion_tokens ?? body.max_tokens
  }
  if (body.prompt_cache_key) out.prompt_cache_key = body.prompt_cache_key
  if (body.parallel_tool_calls != null) out.parallel_tool_calls = body.parallel_tool_calls
  if (body.service_tier != null) out.service_tier = body.service_tier
  return out
}

// The API-key backend currently canonicalizes through Anthropic Messages.
// Until that intermediate format can retain custom input, reject it explicitly.
export function hasCustomChatTools(body = {}) {
  const custom = tool => tool?.type === 'custom' || tool?.custom != null
  const choice = body.tool_choice
  const allowed = choice?.allowed_tools || choice
  return (Array.isArray(body.tools) && body.tools.some(custom)) || custom(choice) ||
    (Array.isArray(allowed?.tools) && allowed.tools.some(custom)) ||
    (Array.isArray(body.messages) && body.messages.some(message => Array.isArray(message?.tool_calls) && message.tool_calls.some(custom)))
}
