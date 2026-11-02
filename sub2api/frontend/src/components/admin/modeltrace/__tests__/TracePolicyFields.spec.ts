import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import TracePolicyFields from '../TracePolicyFields.vue'
import type { TraceConfig } from '@/api/admin/integrationModeltrace'

vi.mock('vue-i18n', () => ({ useI18n: () => ({
  t: (key: string, params?: Record<string, unknown>) => `${key}${params ? ':' + Object.values(params).join('/') : ''}`
}) }))
vi.mock('@/api/admin/integrationClient', () => ({ integrationRequest: vi.fn() }))

const config: TraceConfig = {
  enabled: false, trigger: 'requests', model_mode: 'specified', every_requests: 10,
  interval_seconds: 90, model: 'keep-this-model', sample_count: 3,
  confidence_threshold: 0.8, consecutive_mismatches: 2, action: 'pause', timeout_ms: 90000
}
const wrappers: VueWrapper[] = []
function render(initial: TraceConfig) {
  const wrapper = mount(TracePolicyFields, { props: {
    modelValue: initial,
    'onUpdate:modelValue': (value: TraceConfig) => { void wrapper.setProps({ modelValue: value }) }
  } })
  wrappers.push(wrapper)
  return wrapper
}
afterEach(() => wrappers.splice(0).forEach((wrapper) => wrapper.unmount()))

describe('ModelTrace trigger policy drafts', () => {
  it('preserves legacy 90-second intervals until the user explicitly edits them', async () => {
    const wrapper = render({ ...config, trigger: 'interval' })
    const field = wrapper.get('[data-test="interval-minutes"]')
    expect(field.get('select').element.value).toBe('custom')
    expect(field.get('input').element.value).toBe('1.5')
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
    await wrapper.get('input[type="text"]').setValue('updated-model')
    expect(wrapper.props('modelValue').interval_seconds).toBe(90)
    await field.get('select').setValue('5')
    expect(wrapper.props('modelValue').interval_seconds).toBe(300)
    await field.get('select').setValue('custom')
    expect(wrapper.props('modelValue').interval_seconds).toBe(300)
    await field.get('input').setValue('1.5')
    expect(wrapper.props('modelValue').interval_seconds).toBe(90)
  })
  it('blocks fractional seconds instead of silently rounding a custom minute value', async () => {
    const wrapper = render({ ...config, trigger: 'interval' })
    const input = wrapper.get<HTMLInputElement>('[data-test="interval-minutes"] input')
    await input.setValue('1.001')
    expect(input.element.validationMessage).toContain('admin.modeltrace.policy.wholeSeconds')
    expect(wrapper.props('modelValue').interval_seconds).not.toBe(60)
    await input.setValue('1.5')
    expect(input.element.validationMessage).toBe('')
    expect(wrapper.props('modelValue').interval_seconds).toBe(90)
  })
  it('applies presets only to trigger settings while preserving disabled state and inference policy', async () => {
    const wrapper = render(config)
    expect(wrapper.findAll('button[data-test^="preset-"]')).toHaveLength(10)
    await wrapper.get('[data-test="preset-random10"]').trigger('click')
    expect(wrapper.props('modelValue')).toEqual({ ...config, trigger: 'probability', sampling_probability: 0.1, cooldown_seconds: 600 })
    await wrapper.get('[data-test="preset-and20"]').trigger('click')
    expect(wrapper.props('modelValue')).toMatchObject({
      enabled: false, model: config.model, sample_count: 3, action: 'pause',
      trigger: 'requests_and_interval', every_requests: 20, interval_seconds: 900, cooldown_seconds: 0
    })
    await wrapper.get('[data-test="preset-fixed5"]').trigger('click')
    expect(wrapper.props('modelValue')).toMatchObject({ enabled: false, trigger: 'interval', interval_seconds: 300, action: 'pause', cooldown_seconds: 0 })
  })
  it('converts percentage, cooldown minutes, and idle minutes to the server units', async () => {
    const wrapper = render({ ...config, trigger: 'probability' })
    expect(wrapper.get<HTMLInputElement>('[data-test="sampling-percent"]').element.value).toBe('10')
    await wrapper.get('[data-test="sampling-percent"]').setValue('12.5')
    await wrapper.get('[data-test="cooldown-minutes"] input').setValue('10')
    expect(wrapper.props('modelValue')).toMatchObject({ sampling_probability: 0.125, cooldown_seconds: 600 })
    await wrapper.setProps({ modelValue: { ...wrapper.props('modelValue'), trigger: 'idle_return' } })
    expect(wrapper.get<HTMLInputElement>('[data-test="idle-minutes"] input').element.value).toBe('30')
    await wrapper.get('[data-test="idle-minutes"] input').setValue('45')
    expect(wrapper.props('modelValue').idle_seconds).toBe(2700)
    expect(wrapper.find('[data-test="interval-minutes"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('admin.modeltrace.triggerHelp.idle_return')
  })
})
