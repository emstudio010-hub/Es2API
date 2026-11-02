import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import AccountPoolGroupsDialog from '../AccountPoolGroupsDialog.vue'
import { group } from './fixtures'
const { createGroup, updateGroup } = vi.hoisted(() => ({ createGroup: vi.fn(), updateGroup: vi.fn() }))
vi.mock('@/api/admin/integrationAccounts', () => ({ createIntegrationGroup: createGroup, updateIntegrationGroup: updateGroup }))
vi.mock('@/api/admin/integrationClient', () => ({ integrationErrorMessage: (_: unknown, fallback: string) => fallback }))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
const wrappers: ReturnType<typeof mount>[] = []
function create() {
  const wrapper = mount(AccountPoolGroupsDialog, { props: { show: true, groups: [group] }, global: { stubs: {
    BaseDialog: { template: '<section v-if="show"><slot/><slot name="footer"/></section>', props: ['show'] },
    ConfirmDialog: { template: '<button v-if="show" data-confirm @click="$emit(\'confirm\')">Confirm</button>', props: ['show', 'message', 'title', 'danger'], emits: ['confirm', 'cancel'] }
  } } })
  wrappers.push(wrapper); return wrapper
}
beforeEach(() => { createGroup.mockReset(); updateGroup.mockReset() })
afterEach(() => { wrappers.forEach(wrapper => wrapper.unmount()); wrappers.length = 0 })
describe('account pool groups', () => {
  it('creates shared or per-slot groups and reports feedback', async () => {
    const wrapper = create()
    createGroup.mockResolvedValue({ ...group, id: 'lease-group', name: 'Lease group', strategy: 'per_slot' })
    await wrapper.get('input').setValue('Lease group')
    await wrapper.get('select').setValue('per_slot')
    await wrapper.get('form').trigger('submit'); await flushPromises()
    expect(createGroup).toHaveBeenCalledWith({ name: 'Lease group', strategy: 'per_slot' }, expect.any(AbortSignal))
    expect(wrapper.get('[role="status"]').text()).toContain('groupCreated')
    expect(wrapper.emitted('changed')).toHaveLength(1)
  })
  it('requires confirmation before disabling a group', async () => {
    const wrapper = create()
    updateGroup.mockResolvedValue({ ...group, status: 'inactive' })
    await wrapper.get('li button').trigger('click')
    expect(updateGroup).not.toHaveBeenCalled()
    await wrapper.get('[data-confirm]').trigger('click'); await flushPromises()
    expect(updateGroup).toHaveBeenCalledWith(group.id, { status: 'inactive' }, expect.any(AbortSignal))
    expect(wrapper.get('li button').text()).toContain('enableGroup')
  })
})
