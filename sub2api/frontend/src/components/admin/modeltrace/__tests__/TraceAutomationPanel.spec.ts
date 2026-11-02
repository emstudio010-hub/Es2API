import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { ref } from 'vue'
import TraceAutomationPanel from '../TraceAutomationPanel.vue'
import type { TraceAccountSummary } from '@/api/admin/integrationModeltrace'

vi.mock('vue-i18n', () => ({ useI18n: () => ({
  locale: ref('zh'),
  t: (key: string, params?: Record<string, unknown>) => `${key}${params ? ':' + Object.values(params).join('/') : ''}`
}) }))

const account: TraceAccountSummary = {
  account_id: 'account-a', enabled: true, schedulable: true,
  last_run_id: 'last-run', last_status: 'match', consecutive_mismatches: 0,
  automation: { enabled: true, trigger: 'requests', every_requests: 10,
    successful_since_check: 7, remaining_requests: 3, next_due: null,
    active_run_id: null, last_usage_at: null, blocked_reasons: [], ready: true }
}
function render(accounts: TraceAccountSummary[]) {
  return mount(TraceAutomationPanel, {
    props: { accounts, globalEnabled: true, usageBridge: { configured: true, last_event_at: null } }
  })
}
describe('automatic detection overview', () => {
  it('shows the request threshold and latest result without claiming an intelligence score', async () => {
    const wrapper = render([account])
    expect(wrapper.text()).toContain('admin.modeltrace.automation.requestProgress:7/10')
    expect(wrapper.text()).toContain('admin.modeltrace.automation.remaining:3')
    expect(wrapper.text()).toContain('admin.modeltrace.status.match')
    expect(wrapper.text()).toContain('admin.modeltrace.automation.bridgeReady')
    await wrapper.get('button').trigger('click')
    expect(wrapper.emitted('selected')).toEqual([['account-a']])
    wrapper.unmount()
  })
  it('explains automatic blockers even when the sampling runner itself is ready', () => {
    const wrapper = render([{ ...account, automation: { ...account.automation!, ready: false, enabled: false, blocked_reasons: ['auto_disabled', 'trace_usage_bridge_unconfigured'] } }])
    expect(wrapper.text()).toContain('admin.modeltrace.automation.blocked')
    expect(wrapper.text()).toContain('admin.modeltrace.readiness.auto_disabled')
    expect(wrapper.text()).toContain('admin.modeltrace.readiness.trace_usage_bridge_unconfigured')
    wrapper.unmount()
  })
  it('shows cooldown independently from readiness and does not invent count thresholds for random sampling', () => {
    const wrapper = render([{ ...account, automation: {
      ...account.automation!, trigger: 'probability', remaining_requests: null,
      sampling_probability: 0.1, cooldown_until: '2026-10-31T10:00:00Z', cooldown_remaining_seconds: 120
    } }])
    expect(wrapper.text()).toContain('admin.modeltrace.automation.cooling')
    expect(wrapper.text()).toContain('admin.modeltrace.automation.cooldownUntil')
    expect(wrapper.text()).toContain('admin.modeltrace.automation.probability:10')
    expect(wrapper.text()).not.toContain('admin.modeltrace.automation.requestProgress')
    expect(wrapper.text()).not.toContain('admin.modeltrace.automation.blocked')
    wrapper.unmount()
  })
  it('explains that active-interval and idle-return modes still require user activity', () => {
    const wrapper = render([
      { ...account, automation: { ...account.automation!, trigger: 'active_interval', remaining_requests: null, successful_since_check: 0, next_due: '2026-10-31T10:00:00Z' } },
      { ...account, account_id: 'idle-account', automation: { ...account.automation!, trigger: 'idle_return', remaining_requests: null, idle_seconds: 1800, idle_due_at: '2026-10-31T10:00:00Z' } }
    ])
    expect(wrapper.text()).toContain('admin.modeltrace.automation.activeRequired:0')
    expect(wrapper.text()).toContain('admin.modeltrace.automation.idleRequired:30')
    expect(wrapper.text()).toContain('admin.modeltrace.automation.idleDue')
    wrapper.unmount()
  })
})
