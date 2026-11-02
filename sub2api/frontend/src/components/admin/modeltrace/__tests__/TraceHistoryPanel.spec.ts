import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { ref } from 'vue'
import { modeltraceApi, type TraceRun } from '@/api/admin/integrationModeltrace'
import TraceHistoryPanel from '../TraceHistoryPanel.vue'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key, locale: ref('en') })
}))
vi.mock('@/api/admin/integrationModeltrace', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/api/admin/integrationModeltrace')>(),
  modeltraceApi: { runs: vi.fn(), detail: vi.fn(), cancel: vi.fn() },
  isTraceActive: (status: string) => ['queued', 'running'].includes(status)
}))
vi.mock('@/api/admin/integrationClient', () => ({
  integrationErrorMessage: (error: Error) => error.message
}))
const run = (id: string, status: TraceRun['status']): TraceRun => ({
  id,
  account_id: 'account-a',
  reason: 'manual',
  status,
  created_at: '2026-10-25T00:00:00Z',
  model: 'model-a',
  expected_model: 'model-a',
  applied_action: 'none',
  sample_count: 3
})
const rows = [run('active-run', 'running'), run('finished-run', 'match')]
const wrappers: VueWrapper[] = []
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function render() {
  const wrapper = mount(TraceHistoryPanel, {
    props: { accounts: [], refreshKey: 0 },
    global: {
      stubs: {
        BaseDialog: {
          props: ['show'],
          template:
            '<div v-if="show" data-test="detail"><slot /><slot name="footer" /></div>'
        },
        ConfirmDialog: {
          props: ['show'],
          template:
            '<div v-if="show"><button data-test="confirm" @click="$emit(\'confirm\')">Confirm</button></div>'
        }
      }
    }
  })
  wrappers.push(wrapper)
  return wrapper
}

describe('ModelTrace history', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(modeltraceApi.runs).mockResolvedValue({
      items: rows,
      total: 22,
      page: 1,
      page_size: 20,
      pages: 2
    })
    vi.mocked(modeltraceApi.cancel).mockResolvedValue({ canceled: true })
  })
  afterEach(() => {
    wrappers.splice(0).forEach((wrapper) => wrapper.unmount())
  })
  it('sends explicit filters and pagination to the server', async () => {
    const wrapper = render()
    await flushPromises()
    await wrapper.get('input').setValue('  model-b  ')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(modeltraceApi.runs).toHaveBeenLastCalledWith(
      expect.objectContaining({ model: 'model-b', page: 1, page_size: 20 }),
      expect.any(AbortSignal)
    )
    await wrapper
      .findAll('button')
      .find((button) => button.text() === 'admin.modeltrace.next')!
      .trigger('click')
    await flushPromises()
    expect(modeltraceApi.runs).toHaveBeenLastCalledWith(
      expect.objectContaining({ page: 2 }),
      expect.any(AbortSignal)
    )
  })
  it('offers cancellation only for active records and requires confirmation', async () => {
    const wrapper = render()
    await flushPromises()
    const buttons = wrapper
      .findAll('button')
      .filter((button) => button.text() === 'admin.modeltrace.history.cancel')
    expect(buttons).toHaveLength(1)
    await buttons[0].trigger('click')
    expect(modeltraceApi.cancel).not.toHaveBeenCalled()
    await wrapper.get('[data-test="confirm"]').trigger('click')
    await flushPromises()
    expect(modeltraceApi.cancel).toHaveBeenCalledWith('active-run')
  })
  it.each(['requests_and_interval', 'active_interval', 'probability', 'idle_return'])('filters the new %s trigger reason', async (reason) => {
    const wrapper = render()
    await flushPromises()
    const select = wrapper.findAll('select').find((item) => item.find(`option[value="${reason}"]`).exists())!
    await select.setValue(reason)
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(modeltraceApi.runs).toHaveBeenLastCalledWith(expect.objectContaining({ reason }), expect.any(AbortSignal))
  })
  it('clears old rows and actions when a new filter request fails', async () => {
    const wrapper = render()
    await flushPromises()
    expect(
      wrapper
        .findAll('button')
        .some((button) => button.text() === 'admin.modeltrace.history.cancel')
    ).toBe(true)
    vi.mocked(modeltraceApi.runs).mockRejectedValueOnce(
      new Error('unavailable')
    )
    await wrapper.get('input').setValue('another-model')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(wrapper.text()).toContain('unavailable')
    expect(
      wrapper
        .findAll('button')
        .some((button) => button.text() === 'admin.modeltrace.history.cancel')
    ).toBe(false)
    expect(
      wrapper
        .findAll('button')
        .some((button) => button.text() === 'admin.modeltrace.history.details')
    ).toBe(false)
    expect(wrapper.text()).toContain('admin.modeltrace.history.unavailable')
  })
  it('does not replace a newer detail with an older response', async () => {
    const old = deferred<TraceRun>()
    vi.mocked(modeltraceApi.detail).mockImplementation((id) =>
      id === 'active-run' ? old.promise : Promise.resolve(rows[1])
    )
    const wrapper = render()
    await flushPromises()
    const buttons = wrapper
      .findAll('button')
      .filter((button) => button.text() === 'admin.modeltrace.history.details')
    await buttons[0].trigger('click')
    await buttons[1].trigger('click')
    await flushPromises()
    old.resolve(rows[0])
    await flushPromises()
    expect(wrapper.get('[data-test="detail"]').text()).toContain('finished-run')
    expect(wrapper.get('[data-test="detail"]').text()).not.toContain(
      'active-run'
    )
  })
})
