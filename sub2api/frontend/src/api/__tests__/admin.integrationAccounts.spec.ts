import { beforeEach, describe, expect, it, vi } from 'vitest'
const { request } = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('@/api/admin/integrationClient', () => ({ integrationRequest: request }))
import { createIntegrationGroup, getIntegrationPoolStats, importIntegrationAccount, listIntegrationAccounts, listIntegrationGroups, runIntegrationAccountAction, updateIntegrationAccount, updateIntegrationGroup } from '@/api/admin/integrationAccounts'

describe('integration account HTTP contract', () => {
  beforeEach(() => { request.mockReset(); request.mockResolvedValue({}) })
  it('uses the integration list, group and capacity endpoints with server-side filters', async () => {
    const signal = new AbortController().signal
    await listIntegrationAccounts({ search: 'slot', status: 'error', mode: 'lease', group_id: 'group-x', page: 2, page_size: 20 }, signal)
    expect(request).toHaveBeenLastCalledWith('/accounts', { params: { search: 'slot', status: 'error', mode: 'lease', group_id: 'group-x', page: 2, page_size: 20 }, signal })
    await listIntegrationGroups(signal)
    expect(request).toHaveBeenLastCalledWith('/groups', { signal })
    await getIntegrationPoolStats({ mode: 'pool', group_id: 'g' }, signal)
    expect(request).toHaveBeenLastCalledWith('/pool/stats', { params: { mode: 'pool', group_id: 'g' }, signal })
  })
  it('imports with an idempotency key and no browser management credential', async () => {
    const input = { account_id: 'a', name: 'Account', mode: 'pool' as const, group_ids: ['g'], concurrency: 2, priority: 50, credential: { access_token: 'test-only-oauth' } }
    await importIntegrationAccount(input, 'request-one')
    expect(request).toHaveBeenCalledWith('/accounts', { method: 'POST', data: input, signal: undefined, headers: { 'Idempotency-Key': 'request-one' } })
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
  })
  it('uses PUT updates and lifecycle-specific verbs with encoded identifiers', async () => {
    await updateIntegrationAccount('a/b', { concurrency: 3, priority: 2, group_ids: ['g'] })
    expect(request).toHaveBeenLastCalledWith('/accounts/a%2Fb', { method: 'PUT', data: { concurrency: 3, priority: 2, group_ids: ['g'] }, signal: undefined })
    for (const action of ['sync', 'retry', 'retry-delete'] as const) {
      await runIntegrationAccountAction('a/b', action)
      expect(request).toHaveBeenLastCalledWith(`/accounts/a%2Fb/${action}`, { method: 'POST', signal: undefined })
    }
    await runIntegrationAccountAction('a/b', 'delete')
    expect(request).toHaveBeenLastCalledWith('/accounts/a%2Fb', { method: 'DELETE', signal: undefined })
    await createIntegrationGroup({ name: 'shared', strategy: 'shared' })
    expect(request).toHaveBeenLastCalledWith('/groups', { method: 'POST', data: { name: 'shared', strategy: 'shared', platform: 'openai' }, signal: undefined })
    await updateIntegrationGroup('g:one', { status: 'inactive' })
    expect(request).toHaveBeenLastCalledWith('/groups/g%3Aone', { method: 'PUT', data: { status: 'inactive' }, signal: undefined })
  })
})
