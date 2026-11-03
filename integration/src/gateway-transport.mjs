import { Agent, fetch } from 'undici'

export const GATEWAY_TIMEOUT_MS = 15 * 60 * 1000

// Private execution traffic needs to wait for buffered responses. Keep its
// dispatcher separate from admin/catalog fetches and the process-wide defaults.
export function createGatewayTransport() {
  const dispatcher = new Agent({
    connectTimeout: 10000,
    headersTimeout: GATEWAY_TIMEOUT_MS,
    bodyTimeout: GATEWAY_TIMEOUT_MS,
    pipelining: 1,
  })
  return {
    fetch: (url, options) => fetch(url, { ...options, dispatcher }),
    close: () => dispatcher.close(),
  }
}
