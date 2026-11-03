// A WS response.create is one inference lease. A live socket is not proof of
// inference completion, and an idle socket must not occupy account capacity.
export function createResponseTurnObserver({ claimIdentity = () => {} } = {}) {
  let responseId = null, terminal = null
  const invalid = () => { throw Object.assign(new Error('Invalid execution turn'), { code: 'gateway_ws_protocol' }) }
  return {
    push(payload) {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) || typeof payload.type !== 'string' || terminal) invalid()
      const response = payload.response
      if (response?.id != null && payload.response_id != null && response.id !== payload.response_id) invalid()
      const identity = response?.id ?? payload.response_id
      if (identity != null) {
        if (typeof identity !== 'string' || !identity || identity.length > 512 || (responseId && identity !== responseId)) invalid()
        if (!responseId) claimIdentity(identity)
        responseId = identity
      }
      if (!responseId && !['error', 'response.interrupt.accepted', 'keepalive'].includes(payload.type)) invalid()
      if (payload.error || response?.error || ['error', 'response.failed', 'response.incomplete', 'response.cancelled', 'response.canceled'].includes(payload.type) ||
          ['failed', 'incomplete', 'cancelled', 'canceled'].includes(response?.status)) {
        terminal = { success: false, error_code: 'gateway_ws_response_failed' }
      } else if (['response.completed', 'response.done'].includes(payload.type)) {
        if (response?.status !== 'completed' || !responseId || response.id !== responseId || !Array.isArray(response.output)) invalid()
        terminal = { success: true, error_code: null }
      }
      return terminal
    },
    get responseId() { return responseId },
  }
}
