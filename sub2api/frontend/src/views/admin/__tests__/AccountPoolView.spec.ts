import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import AccountPoolView from '../AccountPoolView.vue'
import { account, group } from '@/components/admin/account-pool/__tests__/fixtures'
const { list, listGroups, stats, action } = vi.hoisted(() => ({ list: vi.fn(), listGroups: vi.fn(), stats: vi.fn(), action: vi.fn() }))
vi.mock('@/api/admin/integrationAccounts', () => ({ listIntegrationAccounts: list, listIntegrationGroups: listGroups, getIntegrationPoolStats: stats, runIntegrationAccountAction: action }))
vi.mock('@/api/admin/accounts', () => ({ generateAuthUrl: vi.fn(), exchangeCode: vi.fn() }))
vi.mock('@/api/admin/integrationClient', () => ({ integrationErrorMessage: (error: Error, fallback: string) => error.message || fallback }))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('@/components/layout/AppLayout.vue', () => ({ default: { template: '<div><slot/></div>' } }))
vi.mock('@/components/common/Pagination.vue', () => ({ default: { template: '<div/>', props: ['total', 'page', 'pageSize', 'pageSizeOptions'] } }))
const rows = (items = [account()]) => ({ items, total: items.length, page: 1, page_size: 20, pages: items.length ? 1 : 0 })
const wrappers: ReturnType<typeof mount>[] = []
function create() {
  const wrapper = mount(AccountPoolView, { global: { stubs: {
    AppLayout: { template: '<div><slot/></div>' }, TablePageLayout: { template: '<div><slot name="actions"/><slot name="filters"/><slot name="table"/><slot name="pagination"/></div>' },
    Pagination: true, RouterLink: { template: '<a><slot/></a>', props: ['to'] }, AccountPoolAccountDialog: true, AccountPoolGroupsDialog: true,
    ConfirmDialog: { template: '<div v-if="show" data-confirm><button @click="$emit(\'confirm\')">Confirm</button><button @click="$emit(\'cancel\')">Cancel</button><slot/></div>', props: ['show', 'message', 'title', 'danger', 'confirmText'], emits: ['confirm', 'cancel'] }
  } } })
  wrappers.push(wrapper)
  return wrapper
}
beforeEach(() => {
  vi.useFakeTimers()
  list.mockReset(); listGroups.mockReset(); stats.mockReset(); action.mockReset()
  list.mockResolvedValue(rows())
  listGroups.mockResolvedValue([group])
  stats.mockResolvedValue({ total: 1, ready: 1, schedulable: 1, available: 1, busy: 0, blocked: 0, by_mode: { pool: 1, lease: 0 }, as_of: '' })
  action.mockResolvedValue({ deleted: true, id: 'account-one', vm_id: 'es2-account-one' })
})
afterEach(() => { wrappers.forEach(wrapper => wrapper.unmount()); wrappers.length = 0; vi.useRealTimers() })
describe('account pool page', () => {
  it('requires confirmation before delete and refreshes after the lifecycle response', async () => {
    const wrapper = create(); await flushPromises()
    await wrapper.get('[data-action="delete"]').trigger('click')
    expect(action).not.toHaveBeenCalled()
    expect(wrapper.get('[data-confirm]').text()).toContain('confirmDelete')
    await wrapper.get('[data-confirm] button').trigger('click'); await flushPromises()
    expect(action).toHaveBeenCalledWith('account-one', 'delete', expect.any(AbortSignal))
    expect(list).toHaveBeenCalledTimes(2)
  })
  it('disables destructive actions while requests are in flight', async () => {
    const active = account(); active.dispatch.inflight_requests = 1
    list.mockResolvedValue(rows([active]))
    const wrapper = create(); await flushPromises()
    expect(wrapper.get('[data-action="delete"]').attributes('disabled')).toBeDefined()
    await wrapper.get('[data-action="delete"]').trigger('click')
    expect(action).not.toHaveBeenCalled()
    expect(wrapper.find('[data-confirm]').exists()).toBe(false)
  })
  it('shows a failed load distinctly from an empty account pool', async () => {
    list.mockRejectedValue(new Error('Integration service unavailable (503)'))
    const wrapper = create(); await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('503')
    expect(wrapper.text()).toContain('admin.accountPool.loadError')
    expect(wrapper.text()).not.toContain('admin.accountPool.empty')
  })
  it('ignores an older response after a filter change and passes group/mode filters to capacity', async () => {
    let resolveOld: (value: ReturnType<typeof rows>) => void = () => {}
    list.mockReturnValueOnce(new Promise(resolve => { resolveOld = resolve }))
    const wrapper = create()
    await wrapper.get('select[aria-label="admin.accountPool.mode"]').setValue('lease')
    await wrapper.get('select[aria-label="admin.accountPool.groupBinding"]').setValue('')
    await vi.advanceTimersByTimeAsync(1); await flushPromises()
    expect(list.mock.calls[list.mock.calls.length - 1][0]).toMatchObject({ mode: 'lease', page: 1 })
    expect(stats.mock.calls[stats.mock.calls.length - 1][0]).toEqual({ mode: 'lease', group_id: undefined })
    resolveOld(rows([account({ name: 'Outdated response' })])); await flushPromises()
    expect(wrapper.text()).not.toContain('Outdated response')
    expect(wrapper.text()).toContain('Example account')
  })
  it('exposes only retry deletion for an unconfirmed deletion record', async () => {
    list.mockResolvedValue(rows([account({ status: 'error', deletion_pending: true })]))
    const wrapper = create(); await flushPromises()
    expect(wrapper.find('[data-action="delete"]').exists()).toBe(false)
    expect(wrapper.find('[data-action="retry"]').exists()).toBe(false)
    await wrapper.get('[data-action="retry-delete"]').trigger('click')
    expect(action).not.toHaveBeenCalled()
    await wrapper.get('[data-confirm] button').trigger('click'); await flushPromises()
    expect(action).toHaveBeenCalledWith('account-one', 'retry-delete', expect.any(AbortSignal))
  })
})
