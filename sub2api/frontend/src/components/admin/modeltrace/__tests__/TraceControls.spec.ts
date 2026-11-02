import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import {
  modeltraceApi,
  type TraceAccountConfig,
  type TraceConfig
} from '@/api/admin/integrationModeltrace'
import TraceAccountPanel from '../TraceAccountPanel.vue'
import TracePolicyPanel from '../TracePolicyPanel.vue'

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('@/api/admin/integrationModeltrace', () => ({
  modeltraceApi: {
    account: vi.fn(),
    run: vi.fn(),
    resetAction: vi.fn(),
    saveAccount: vi.fn(),
    saveConfig: vi.fn()
  }
}))
vi.mock('@/api/admin/integrationClient', () => ({
  integrationErrorMessage: (error: Error) => error.message
}))
const config: TraceConfig = {
  enabled: true,
  trigger: 'requests',
  model_mode: 'specified',
  every_requests: 10,
  interval_seconds: 3600,
  model: 'model-a',
  sample_count: 3,
  confidence_threshold: 0.8,
  consecutive_mismatches: 2,
  action: 'observe',
  timeout_ms: 90000
}
const info = (id: string): TraceAccountConfig => ({
  account_id: id,
  overrides: {},
  effective_config: { ...config },
  state: { last_status: id === 'a' ? 'match' : 'inconclusive' }
})
const accounts = ['a', 'b'].map((account_id) => ({
  account_id,
  enabled: true,
  schedulable: true,
  last_run_id: null,
  last_status: null,
  consecutive_mismatches: 0
}))
const stubs = {
  TracePolicyFields: true,
  ConfirmDialog: {
    name: 'ConfirmDialog',
    props: ['show', 'message'],
    template:
      '<div v-if="show" data-test="confirmation"><p>{{ message }}</p><button data-test="confirm" @click="$emit(\'confirm\')">Confirm</button><button data-test="cancel" @click="$emit(\'cancel\')">Cancel</button></div>'
  }
}
const mounted: VueWrapper[] = []
function button(wrapper: VueWrapper, text: string) {
  return wrapper.findAll('button').find((item) => item.text() === text)!
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function mountAccount() {
  const wrapper = mount(TraceAccountPanel, {
    props: { accounts, bankReady: true, refreshKey: 0 },
    global: { stubs }
  })
  mounted.push(wrapper)
  return wrapper
}

describe('ModelTrace controls', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(modeltraceApi.account).mockImplementation(async (id) => info(id))
    vi.mocked(modeltraceApi.run).mockResolvedValue({ id: 'run-a' } as never)
  })
  afterEach(() => {
    mounted.splice(0).forEach((wrapper) => wrapper.unmount())
  })
  it('does not sample until the user confirms and prevents a duplicate submission', async () => {
    const run = deferred<never>()
    vi.mocked(modeltraceApi.run).mockReturnValue(run.promise)
    const wrapper = mountAccount()
    await flushPromises()
    await button(wrapper, 'admin.modeltrace.account.run').trigger('click')
    expect(modeltraceApi.run).not.toHaveBeenCalled()
    expect(wrapper.find('[data-test="confirmation"]').exists()).toBe(true)
    const dialog = wrapper.findComponent({ name: 'ConfirmDialog' })
    // Repeated confirm events cannot dispatch the same mutation twice.
    dialog.vm.$emit('confirm')
    dialog.vm.$emit('confirm')
    await flushPromises()
    expect(modeltraceApi.run).toHaveBeenCalledTimes(1)
    expect(modeltraceApi.run).toHaveBeenCalledWith('a')
    run.resolve({ id: 'run-a' } as never)
    await flushPromises()
  })
  it('leaves the account untouched when confirmation is canceled', async () => {
    const wrapper = mountAccount()
    await flushPromises()
    await button(wrapper, 'admin.modeltrace.account.run').trigger('click')
    await wrapper.get('[data-test="cancel"]').trigger('click')
    expect(modeltraceApi.run).not.toHaveBeenCalled()
    expect(wrapper.find('[data-test="confirmation"]').exists()).toBe(false)
  })
  it('explains readiness blockers and prevents sampling an unready slot', async () => {
    vi.mocked(modeltraceApi.account).mockResolvedValue({ ...info('a'), readiness: {
      ready: false, blockers: ['slot_not_ready', 'trace_runner_unavailable'], runner_configured: false, model: 'model-a'
    } })
    const wrapper = mountAccount()
    await flushPromises()
    expect(button(wrapper, 'admin.modeltrace.account.run').attributes('disabled')).toBeDefined()
    expect(wrapper.text()).toContain('admin.modeltrace.readiness.slot_not_ready')
    expect(wrapper.text()).toContain('admin.modeltrace.readiness.trace_runner_unavailable')
    await button(wrapper, 'admin.modeltrace.account.run').trigger('click')
    expect(modeltraceApi.run).not.toHaveBeenCalled()
  })
  it('discards an older account response after the selection changes', async () => {
    const old = deferred<TraceAccountConfig>()
    vi.mocked(modeltraceApi.account).mockImplementation((id) =>
      id === 'a' ? old.promise : Promise.resolve(info('b'))
    )
    const wrapper = mountAccount()
    await wrapper.get('select').setValue('b')
    await flushPromises()
    expect(wrapper.text()).toContain('admin.modeltrace.status.inconclusive')
    old.resolve(info('a'))
    await flushPromises()
    expect(wrapper.text()).toContain('admin.modeltrace.status.inconclusive')
    expect(wrapper.text()).not.toContain('admin.modeltrace.status.match')
  })
  it('sends inherit:true when clearing existing account overrides', async () => {
    vi.mocked(modeltraceApi.account).mockResolvedValue({
      ...info('a'),
      overrides: { action: 'pause' }
    })
    vi.mocked(modeltraceApi.saveAccount).mockResolvedValue({
      overrides: {},
      effective_config: config
    })
    const wrapper = mountAccount()
    await flushPromises()
    await wrapper.get('input[type="checkbox"]').setValue(true)
    await wrapper.get('form').trigger('submit')
    expect(modeltraceApi.saveAccount).not.toHaveBeenCalled()
    await wrapper.get('[data-test="confirm"]').trigger('click')
    await flushPromises()
    expect(modeltraceApi.saveAccount).toHaveBeenCalledWith('a', {
      inherit: true
    })
  })
  it('enables request-triggered automation without sampling or replacing unrelated policy', async () => {
    vi.mocked(modeltraceApi.account).mockResolvedValue({ ...info('a'), overrides: { enabled: false, trigger: 'manual' }, effective_config: { ...config, enabled: false, trigger: 'manual', action: 'pause' } })
    const save = deferred<never>()
    vi.mocked(modeltraceApi.saveAccount).mockReturnValue(save.promise)
    const wrapper = mountAccount()
    await flushPromises()
    const toggle = wrapper.get('[data-test="toggle-automatic"]')
    await toggle.trigger('click')
    await toggle.trigger('click')
    expect(modeltraceApi.saveAccount).toHaveBeenCalledTimes(1)
    expect(modeltraceApi.saveAccount).toHaveBeenCalledWith('a', { enabled: true, trigger: 'requests' })
    expect(modeltraceApi.run).not.toHaveBeenCalled()
    save.resolve({ overrides: {}, effective_config: config } as never)
    await flushPromises()
  })
  it('blocks enabling automation while the global switch is off', async () => {
    vi.mocked(modeltraceApi.account).mockResolvedValue({ ...info('a'), effective_config: { ...config, enabled: false } })
    const wrapper = mountAccount()
    await wrapper.setProps({ globalEnabled: false })
    await flushPromises()
    const toggle = wrapper.get('[data-test="toggle-automatic"]')
    expect(toggle.attributes('disabled')).toBeDefined()
    expect(wrapper.text()).toContain('admin.modeltrace.automation.enableGlobalFirst')
    await toggle.trigger('click')
    expect(modeltraceApi.saveAccount).not.toHaveBeenCalled()
  })
  it.each(['interval', 'requests_and_interval', 'active_interval', 'probability', 'idle_return'] as const)('preserves the saved %s policy when enabling automation', async (trigger) => {
    vi.mocked(modeltraceApi.account).mockResolvedValue({ ...info('a'), effective_config: { ...config, enabled: false, trigger } })
    vi.mocked(modeltraceApi.saveAccount).mockResolvedValue({ overrides: { enabled: true, trigger }, effective_config: { ...config, trigger } })
    const wrapper = mountAccount()
    await flushPromises()
    await wrapper.get('[data-test="toggle-automatic"]').trigger('click')
    await flushPromises()
    expect(modeltraceApi.saveAccount).toHaveBeenCalledWith('a', { enabled: true, trigger })
    expect(modeltraceApi.run).not.toHaveBeenCalled()
  })
  it('disables future automation without canceling an active run or changing the trigger', async () => {
    vi.mocked(modeltraceApi.saveAccount).mockResolvedValue({ overrides: { enabled: false }, effective_config: { ...config, enabled: false } })
    const wrapper = mountAccount()
    await flushPromises()
    await wrapper.get('[data-test="toggle-automatic"]').trigger('click')
    await flushPromises()
    expect(modeltraceApi.saveAccount).toHaveBeenCalledWith('a', { enabled: false })
    expect(modeltraceApi.run).not.toHaveBeenCalled()
  })
  it('applies an overview selection after an in-flight account update completes', async () => {
    const save = deferred<never>()
    vi.mocked(modeltraceApi.saveAccount).mockReturnValue(save.promise)
    const wrapper = mountAccount()
    await wrapper.setProps({ initialAccount: 'a' })
    await flushPromises()
    await wrapper.get('[data-test="toggle-automatic"]').trigger('click')
    await wrapper.setProps({ initialAccount: 'b' })
    expect(wrapper.get('select').element.value).toBe('a')
    save.resolve({ overrides: {}, effective_config: config } as never)
    await flushPromises()
    expect(modeltraceApi.saveAccount).toHaveBeenCalledWith('a', { enabled: false })
    expect(wrapper.get('select').element.value).toBe('b')
    expect(wrapper.text()).toContain('admin.modeltrace.status.inconclusive')
  })
  it('preserves a dirty global policy through a background refresh and failed save', async () => {
    vi.mocked(modeltraceApi.saveConfig).mockRejectedValue(
      new Error('save failed')
    )
    const wrapper = mount(TracePolicyPanel, {
      props: { config },
      global: { stubs }
    })
    mounted.push(wrapper)
    wrapper
      .findComponent({ name: 'TracePolicyFields' })
      .vm.$emit('update:modelValue', { ...config, action: 'pause' })
    await flushPromises()
    await wrapper.setProps({ config: { ...config, model: 'new-global-model' } })
    await wrapper.get('form').trigger('submit')
    expect(modeltraceApi.saveConfig).not.toHaveBeenCalled()
    await wrapper.get('[data-test="confirm"]').trigger('click')
    await flushPromises()
    expect(modeltraceApi.saveConfig).toHaveBeenCalledWith({
      ...config,
      action: 'pause'
    })
    expect(wrapper.text()).toContain('save failed')
    expect(wrapper.text()).toContain('admin.modeltrace.unsaved')
  })
})
