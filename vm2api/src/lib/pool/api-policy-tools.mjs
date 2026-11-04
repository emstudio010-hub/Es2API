import { officialMessagesBody } from '../protocol/anthropic-messages.mjs'
import { sanitizeAnthropicTools } from '../protocol/web-search.mjs'

// Internal policy representation only. These tags must never reach a provider.
export const API_CUSTOM_TOOL = 'es2api_custom_tool'
export const API_CUSTOM_USE = 'es2api_custom_tool_use'
export const API_FUNCTION_USE = 'es2api_function_tool_use'

export function apiPolicyInputError(code = 'api_bridge_tool_input_invalid') {
  return Object.assign(new Error('The API endpoint cannot preserve this tool contract'), { code })
}
export function isApiPolicyInputError(error) {
  return ['api_bridge_tool_input_invalid', 'api_bridge_custom_tool_unsupported', 'api_bridge_policy_tools_required', 'api_bridge_responses_input_unsupported', 'api_bridge_input_unsupported'].includes(error?.code)
}
function customChoice(choice) {
  const allowed = choice?.allowed_tools || choice
  return choice?.type === 'custom' || allowed?.tools?.some?.(tool => tool?.type === 'custom')
}
export function hasApiCustomPolicy(body = {}) {
  return body.tools?.some?.(tool => tool?.type === API_CUSTOM_TOOL) || customChoice(body.tool_choice) ||
    body.messages?.some?.(message => message?.content?.some?.(block => block?.type === API_CUSTOM_USE)) || false
}
function hasInternalUse(body = {}) {
  return hasApiCustomPolicy(body) || body.messages?.some?.(message => message?.content?.some?.(block => block?.type === API_FUNCTION_USE))
}

/** Sanitize provider fields without erasing explicit internal custom types. */
export function canonicalApiPolicyBody(body = {}, { allowInternalTools = false } = {}) {
  if (!allowInternalTools && hasInternalUse(body)) throw apiPolicyInputError('api_bridge_policy_tools_required')
  if (allowInternalTools && ((body.tools != null && !Array.isArray(body.tools)) || !Array.isArray(body.messages))) throw apiPolicyInputError()
  const out = officialMessagesBody(body)
  if (!allowInternalTools) return out
  // Anthropic normalization merges adjacent turns and lifts system messages.
  // Keep post-policy order for OpenAI; native Anthropic is normalized below.
  out.messages = body.messages
  if (body.system != null) out.system = body.system
  else delete out.system
  if (Array.isArray(body.tools) && body.tools.length) {
    out.tools = body.tools.flatMap(tool => tool?.type === API_CUSTOM_TOOL ? [tool] : sanitizeAnthropicTools([tool]))
    if (body.tool_choice != null) out.tool_choice = body.tool_choice
  }
  // Only post-policy values travel onward. No original-request side channel.
  if (body.parallel_tool_calls != null) out.parallel_tool_calls = body.parallel_tool_calls
  return out
}

/** Native Anthropic has no raw custom tool input; function arguments need an object. */
export function apiPolicyToAnthropic(body = {}) {
  if (hasApiCustomPolicy(body)) throw apiPolicyInputError('api_bridge_custom_tool_unsupported')
  const { parallel_tool_calls: _parallel, ...out } = body
  const choice = body.tool_choice
  if (typeof choice === 'string') {
    if (!['none', 'auto', 'required'].includes(choice)) throw apiPolicyInputError()
    out.tool_choice = { type: choice === 'required' ? 'any' : choice }
  } else if (choice?.type === 'function') {
    const name = choice.function?.name || choice.name
    if (!name) throw apiPolicyInputError()
    out.tool_choice = { type: 'tool', name }
  } else if (choice?.type === 'allowed_tools') {
    // Anthropic has no corresponding per-call allow-list contract.
    throw apiPolicyInputError()
  }
  out.messages = (body.messages || []).map(message => ({ ...message,
    content: Array.isArray(message.content) ? message.content.map(block => {
      if (block?.type !== API_FUNCTION_USE) return block
      let input
      try { input = JSON.parse(block.input) } catch { throw apiPolicyInputError() }
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw apiPolicyInputError()
      return { type: 'tool_use', id: block.id, name: block.name, input }
    }) : message.content,
  }))
  return officialMessagesBody(out)
}
