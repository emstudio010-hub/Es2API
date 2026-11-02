import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { ref } from 'vue'
import {
  modeltraceApi,
  type TraceSummary
} from '@/api/admin/integrationModeltrace'
import ModelTraceView from '../ModelTraceView.vue'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key, locale: ref('en') })
}))
vi.mock('vue-router', () => ({
  useRoute: () => ({ query: { account_id: 'account-a' } })
}))
vi.mock('@/components/layout/AppLayout.vue', () => ({
  default: { template: '<div><slot /></div>' }
}))
vi.mock('@/api/admin/integrationModeltrace', () => ({
  modeltraceApi: { summary: vi.fn() }
}))
vi.mock('@/api/admin/integrationClient', () => ({
  integrationErrorMessage: (error: Error) => error.message
}))
const summary = (active_runs: number): TraceSummary => ({
  active_runs,
  config: {
    enabled: true,
    trigger: 'manual',
    model_mode: 'specified',
    every_requests: 10,
    interval_seconds: 3600,
    model: 'model-a',
    sample_count: 3,
    confidence_threshold: 0.8,
    consecutive_mismatches: 2,
    action: 'observe',
    timeout_ms: 90000
  },
  bank: { revision: null, models: [], challenges: [], ready: false },
  run_counts: {},
  accounts: [],
  as_of: '2026-10-25T00:00:00Z'
})
const mounted: VueWrapper[] = []
function render() {
  const wrapper = mount(ModelTraceView, {
    global: {
      stubs: {
        AppLayout: { template: '<div><slot /></div>' },
        TracePolicyPanel: true,
        TraceBankPanel: true,
        TraceAutomationPanel: true,
        TraceAccountPanel: true,
        TraceHistoryPanel: true
      }
    }
  })
  mounted.push(wrapper)
  return wrapper
}

describe('ModelTrace active-task polling', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
  })
  afterEach(() => {
    mounted.splice(0).forEach((wrapper) => wrapper.unmount())
    vi.useRealTimers()
  })
  it('does not poll an idle page and forwards account deep links', async () => {
    vi.mocked(modeltraceApi.summary).mockResolvedValue(summary(0))
    const wrapper = render()
    await flushPromises()
    await vi.advanceTimersByTimeAsync(20000)
    expect(modeltraceApi.summary).toHaveBeenCalledTimes(1)
    expect(
      wrapper
        .findComponent({ name: 'TraceAccountPanel' })
        .props('initialAccount')
    ).toBe('account-a')
  })
  it('refreshes active runs once, then stops when the server reports completion', async () => {
    vi.mocked(modeltraceApi.summary)
      .mockResolvedValueOnce(summary(1))
      .mockResolvedValue(summary(0))
    render()
    await flushPromises()
    await vi.advanceTimersByTimeAsync(5000)
    await flushPromises()
    await vi.advanceTimersByTimeAsync(20000)
    expect(modeltraceApi.summary).toHaveBeenCalledTimes(2)
  })
  it('cleans up the polling timer and cancels reads when unmounted', async () => {
    vi.mocked(modeltraceApi.summary).mockResolvedValue(summary(1))
    const wrapper = render()
    await flushPromises()
    const signal = vi.mocked(modeltraceApi.summary).mock.calls[0][0]
    wrapper.unmount()
    mounted.splice(mounted.indexOf(wrapper), 1)
    await vi.advanceTimersByTimeAsync(10000)
    expect(signal?.aborted).toBe(true)
    expect(modeltraceApi.summary).toHaveBeenCalledTimes(1)
  })
  it('discovers externally triggered runs while automatic detection is enabled', async () => {
    const idle = { ...summary(0), accounts: [{
      account_id: 'account-a', enabled: true, schedulable: true,
      last_run_id: null, last_status: null, consecutive_mismatches: 0,
      automation: { enabled: true, trigger: 'requests' as const, every_requests: 10,
        successful_since_check: 9, remaining_requests: 1, next_due: null,
        active_run_id: null, last_usage_at: null, blocked_reasons: [], ready: true }
    }] }
    vi.mocked(modeltraceApi.summary).mockResolvedValueOnce(idle).mockResolvedValue(summary(1))
    const wrapper = render()
    await flushPromises()
    expect(wrapper.text()).toContain('admin.modeltrace.summary.monitoring')
    await vi.advanceTimersByTimeAsync(15000)
    expect(modeltraceApi.summary).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(5000)
    expect(modeltraceApi.summary).toHaveBeenCalledTimes(3)
  })
  it('links the automation overview selection to account controls and history', async () => {
    vi.mocked(modeltraceApi.summary).mockResolvedValue(summary(0))
    const wrapper = render()
    await flushPromises()
    wrapper.findComponent({ name: 'TraceAutomationPanel' }).vm.$emit('selected', 'account-b')
    await flushPromises()
    expect(wrapper.findComponent({ name: 'TraceAccountPanel' }).props('initialAccount')).toBe('account-b')
    expect(wrapper.findComponent({ name: 'TraceHistoryPanel' }).props('initialAccount')).toBe('account-b')
  })
  it('shows a recoverable error instead of claiming an empty integration is healthy', async () => {
    vi.mocked(modeltraceApi.summary).mockRejectedValue(
      new Error('integration unavailable')
    )
    const wrapper = render()
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain(
      'integration unavailable'
    )
    expect(wrapper.findComponent({ name: 'TracePolicyPanel' }).exists()).toBe(
      false
    )
  })
})
