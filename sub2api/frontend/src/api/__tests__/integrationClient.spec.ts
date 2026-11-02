import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import axios from 'axios'
import apiClient from '../client'
import { integrationRequest } from '../admin/integrationClient'

const originalAdapter = apiClient.defaults.adapter

describe('administrator integration client', () => {
  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('auth_token', 'test-admin-session')
  })
  afterEach(() => {
    apiClient.defaults.adapter = originalAdapter
    localStorage.clear()
  })

  it('uses the existing admin session and unwraps the integration envelope', async () => {
    const adapter = vi.fn(async (config) => ({
      config, headers: {}, status: 200, statusText: 'OK',
      data: { ok: true, data: { items: [], total: 0 } },
    }))
    apiClient.defaults.adapter = adapter
    await expect(integrationRequest('/accounts', { params: { page: 2 } })).resolves.toEqual({ items: [], total: 0 })
    const config = adapter.mock.calls[0][0]
    expect(config.url).toBe('/admin/integration/accounts')
    expect(config.headers.get('Authorization')).toBe('Bearer test-admin-session')
    expect(config.headers.get('X-Admin-UI-Request')).toBe('1')
    expect(config.params.page).toBe(2)
  })

  it('preserves lifecycle conflict details instead of a generic HTTP error', async () => {
    apiClient.defaults.adapter = vi.fn(async (config) => {
      throw new axios.AxiosError('Request failed', 'ERR_BAD_REQUEST', config, null, {
        config, headers: {}, status: 409, statusText: 'Conflict',
        data: { ok: false, error: { code: 'account_busy', message: '账号仍有在途请求', request_id: 'test-request' } },
      })
    })
    await expect(integrationRequest('/accounts/a', { method: 'DELETE' })).rejects.toMatchObject({
      status: 409, code: 'account_busy', message: '账号仍有在途请求', request_id: 'test-request',
    })
    expect(localStorage.getItem('auth_token')).toBe('test-admin-session')
  })

  it('rejects an unexpected response instead of treating it as an empty success', async () => {
    apiClient.defaults.adapter = vi.fn(async (config) => ({
      config, headers: {}, status: 200, statusText: 'OK', data: '<html>login</html>',
    }))
    await expect(integrationRequest('/pool/stats')).rejects.toMatchObject({ code: 'invalid_integration_response' })
  })

  it('preserves cancellation so stale loads can be ignored', async () => {
    apiClient.defaults.adapter = vi.fn(async () => { throw new axios.CanceledError('canceled') })
    const request = integrationRequest('/accounts')
    await expect(request).rejects.toSatisfy(axios.isCancel)
  })

  it.each(['https://example.com', '//example.com', '/../settings', '/accounts?token=x'])('rejects invalid path %s', async (path) => {
    const adapter = vi.fn()
    apiClient.defaults.adapter = adapter
    await expect(integrationRequest(path)).rejects.toThrow('Invalid integration API path')
    expect(adapter).not.toHaveBeenCalled()
  })
})
