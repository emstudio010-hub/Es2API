// A WS response.create is one inference lease. A live socket is not proof of
// inference completion, and an idle socket must not occupy account capacity.
export function createResponseTurnObserver() {
  let responseId = null, terminal = null
  const invalid = () => { throw Object.assign(new Error('Invalid execution turn'), { code: 'gateway_ws_protocol' }) }
  return {
    push(payload) {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) || typeof payload.type !== 'string' || terminal) invalid()
      const response = payload.response
      const identity = response?.id || payload.response_id
      if (identity != null) {
        if (typeof identity !== 'string' || !identity || identity.length > 512 || (responseId && identity !== responseId)) invalid()
        responseId = identity
      }
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
