<script setup lang="ts">
import { onMounted, onUnmounted, reactive, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import BaseDialog from '@/components/common/BaseDialog.vue'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'
import {
  modeltraceApi,
  traceRunReasons,
  isTraceActive,
  type TraceAccountSummary,
  type TraceRun,
  type TraceRunPage
} from '@/api/admin/integrationModeltrace'
import { integrationErrorMessage } from '@/api/admin/integrationClient'
const props = defineProps<{
  accounts: TraceAccountSummary[]
  refreshKey: number
  initialAccount?: string
}>()
const emit = defineEmits<{ changed: [] }>()
const { t, te, locale } = useI18n()
function runErrorMessage(value: NonNullable<TraceRun['error']>) {
  const key = `admin.modeltrace.history.errors.${value.code}`
  return te(key) ? t(key) : value.message
}
const statuses = [
  'queued',
  'running',
  'match',
  'suspected_mismatch',
  'inconclusive',
  'insufficient_samples',
  'unlisted_model',
  'canceled',
  'error'
]
const filters = reactive({
  account_id: props.initialAccount || '',
  status: '',
  reason: '',
  model: ''
})
let applied = { ...filters }
const page = ref(1),
  pageSize = ref(20),
  result = shallowRef<TraceRunPage | null>(null),
  loading = ref(false),
  error = ref(''),
  notice = ref('')
const detailId = ref(''),
  detail = shallowRef<TraceRun | null>(null),
  detailLoading = ref(false),
  detailError = ref('')
const pendingCancel = shallowRef<TraceRun | null>(null),
  canceling = ref(false)
let disposed = false,
  generation = 0,
  detailGeneration = 0,
  controller: AbortController | undefined,
  detailController: AbortController | undefined
function formatTime(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString(locale.value)
}
function percent(value?: number | null) {
  return value == null ? '—' : `${(value * 100).toFixed(1)}%`
}
function statusClass(status: string) {
  return status === 'suspected_mismatch'
    ? 'text-amber-700 dark:text-amber-400'
    : status === 'error'
      ? 'text-red-600'
      : status === 'match'
        ? 'text-green-600'
        : 'text-gray-600 dark:text-dark-300'
}
function applyFilters() {
  applied = { ...filters, model: filters.model.trim() }
  page.value = 1
  void load()
}
function clearFilters() {
  Object.assign(filters, { account_id: '', status: '', reason: '', model: '' })
  applyFilters()
}
function changePageSize() {
  page.value = 1
  void load()
}
function changePage(delta: number) {
  page.value += delta
  void load()
}
async function load() {
  controller?.abort()
  controller = new AbortController()
  const request = ++generation
  loading.value = true
  error.value = ''
  try {
    const value = await modeltraceApi.runs(
      { ...applied, page: page.value, page_size: pageSize.value },
      controller.signal
    )
    if (!disposed && request === generation) {
      result.value = value
      page.value = value.page
    }
  } catch (cause) {
    if (!disposed && request === generation) {
      result.value = null
      error.value = integrationErrorMessage(
        cause,
        t('admin.modeltrace.requestFailed')
      )
    }
  } finally {
    if (!disposed && request === generation) loading.value = false
  }
}
function openDetail(id: string) {
  detail.value = null
  detailId.value = id
  void fetchDetail()
}
function closeDetail() {
  detailId.value = ''
  detail.value = null
  detailError.value = ''
  detailGeneration++
  detailController?.abort()
}
async function fetchDetail() {
  if (!detailId.value) return
  detailController?.abort()
  detailController = new AbortController()
  const request = ++detailGeneration
  detailLoading.value = true
  detailError.value = ''
  try {
    const value = await modeltraceApi.detail(
      detailId.value,
      detailController.signal
    )
    if (!disposed && request === detailGeneration) detail.value = value
  } catch (cause) {
    if (!disposed && request === detailGeneration)
      detailError.value = integrationErrorMessage(
        cause,
        t('admin.modeltrace.requestFailed')
      )
  } finally {
    if (!disposed && request === detailGeneration) detailLoading.value = false
  }
}
async function cancelRun() {
  if (!pendingCancel.value || canceling.value) return
  const id = pendingCancel.value.id
  pendingCancel.value = null
  canceling.value = true
  error.value = ''
  notice.value = ''
  try {
    const value = await modeltraceApi.cancel(id)
    if (disposed) return
    notice.value = t(
      value.canceled
        ? 'admin.modeltrace.history.cancelRequested'
        : 'admin.modeltrace.history.alreadyFinished'
    )
    await load()
    if (detailId.value === id) await fetchDetail()
    emit('changed')
  } catch (cause) {
    if (!disposed)
      error.value = integrationErrorMessage(
        cause,
        t('admin.modeltrace.requestFailed')
      )
  } finally {
    if (!disposed) canceling.value = false
  }
}
watch(
  () => props.refreshKey,
  () => {
    void load()
    if (detailId.value && detail.value && isTraceActive(detail.value.status))
      void fetchDetail()
  }
)
watch(
  () => props.initialAccount,
  (id) => {
    filters.account_id = id || ''
    applyFilters()
  }
)
onMounted(load)
onUnmounted(() => {
  disposed = true
  generation++
  detailGeneration++
  controller?.abort()
  detailController?.abort()
})
</script>

<template>
  <section class="card overflow-hidden">
    <div class="space-y-4 p-5">
      <div class="flex items-center justify-between gap-3">
        <h2 class="text-lg font-semibold">
          {{ t('admin.modeltrace.history.title') }}
        </h2>
        <button
          type="button"
          class="btn btn-secondary"
          :disabled="loading"
          @click="load"
        >
          {{ t('admin.modeltrace.refresh') }}
        </button>
      </div>
      <form
        class="grid gap-3 sm:grid-cols-2 lg:grid-cols-5"
        @submit.prevent="applyFilters"
      >
        <label class="space-y-1 text-sm"
          ><span>{{ t('admin.modeltrace.history.account') }}</span
          ><select v-model="filters.account_id" class="input">
            <option value="">{{ t('admin.modeltrace.all') }}</option>
            <option
              v-for="account in accounts"
              :key="account.account_id"
              :value="account.account_id"
            >
              {{ account.account_id }}
            </option>
          </select></label
        >
        <label class="space-y-1 text-sm"
          ><span>{{ t('admin.modeltrace.history.status') }}</span
          ><select v-model="filters.status" class="input">
            <option value="">{{ t('admin.modeltrace.all') }}</option>
            <option v-for="status in statuses" :key="status" :value="status">
              {{ t(`admin.modeltrace.status.${status}`) }}
            </option>
          </select></label
        >
        <label class="space-y-1 text-sm"
          ><span>{{ t('admin.modeltrace.history.reason') }}</span
          ><select v-model="filters.reason" class="input">
            <option value="">{{ t('admin.modeltrace.all') }}</option>
            <option
              v-for="reason in traceRunReasons"
              :key="reason"
              :value="reason"
            >
              {{ t(`admin.modeltrace.triggers.${reason}`) }}
            </option>
          </select></label
        >
        <label class="space-y-1 text-sm"
          ><span>{{ t('admin.modeltrace.history.model') }}</span
          ><input
            v-model="filters.model"
            class="input"
            type="text"
            maxlength="150"
            :placeholder="t('admin.modeltrace.history.exactModel')"
        /></label>
        <div class="flex items-end gap-2">
          <button type="submit" class="btn btn-primary">
            {{ t('admin.modeltrace.history.filter') }}</button
          ><button
            type="button"
            class="btn btn-secondary"
            @click="clearFilters"
          >
            {{ t('admin.modeltrace.history.clear') }}
          </button>
        </div>
      </form>
      <p v-if="error" role="alert" class="text-sm text-red-600">{{ error }}</p>
      <p v-if="notice" role="status" class="text-sm text-green-600">
        {{ notice }}
      </p>
    </div>
    <div :aria-busy="loading" class="overflow-x-auto">
      <table class="w-full text-left text-sm">
        <thead
          class="bg-gray-50 text-xs text-gray-500 dark:bg-dark-800 dark:text-dark-400"
        >
          <tr>
            <th class="px-5 py-3">{{ t('admin.modeltrace.history.time') }}</th>
            <th class="px-5 py-3">
              {{ t('admin.modeltrace.history.account') }}
            </th>
            <th class="px-5 py-3">{{ t('admin.modeltrace.history.model') }}</th>
            <th class="px-5 py-3">
              {{ t('admin.modeltrace.history.status') }}
            </th>
            <th class="px-5 py-3">
              {{ t('admin.modeltrace.history.reason') }}
            </th>
            <th class="px-5 py-3">
              {{ t('admin.modeltrace.history.action') }}
            </th>
            <th class="px-5 py-3">
              {{ t('admin.modeltrace.history.operations') }}
            </th>
          </tr>
        </thead>
        <tbody class="divide-y divide-gray-100 dark:divide-dark-700">
          <tr v-for="run in result?.items || []" :key="run.id">
            <td class="whitespace-nowrap px-5 py-3">
              {{ formatTime(run.created_at) }}
            </td>
            <td class="max-w-56 break-all px-5 py-3 font-mono text-xs">
              {{ run.account_id }}
            </td>
            <td class="px-5 py-3">{{ run.model }}</td>
            <td class="whitespace-nowrap px-5 py-3">
              <span :class="statusClass(run.status)">{{
                t(`admin.modeltrace.status.${run.status}`)
              }}</span>
            </td>
            <td class="whitespace-nowrap px-5 py-3">
              {{ t(`admin.modeltrace.triggers.${run.reason}`) }}
            </td>
            <td class="whitespace-nowrap px-5 py-3">
              {{ t(`admin.modeltrace.actions.${run.applied_action}`) }}
            </td>
            <td class="px-5 py-3">
              <div class="flex gap-3 whitespace-nowrap">
                <button
                  type="button"
                  class="font-medium text-primary-600 hover:underline"
                  @click="openDetail(run.id)"
                >
                  {{ t('admin.modeltrace.history.details') }}</button
                ><button
                  v-if="isTraceActive(run.status)"
                  type="button"
                  class="font-medium text-red-600 hover:underline disabled:opacity-50"
                  :disabled="canceling"
                  @click="pendingCancel = run"
                >
                  {{ t('admin.modeltrace.history.cancel') }}
                </button>
              </div>
            </td>
          </tr>
          <tr v-if="!result?.items.length">
            <td colspan="7" class="px-5 py-10 text-center text-gray-500">
              {{
                t(
                  loading
                    ? 'admin.modeltrace.loading'
                    : error
                      ? 'admin.modeltrace.history.unavailable'
                      : 'admin.modeltrace.history.empty'
                )
              }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <div
      class="flex flex-wrap items-center justify-between gap-3 border-t border-gray-100 px-5 py-4 text-sm dark:border-dark-700"
    >
      <span>{{
        t('admin.modeltrace.history.pagination', {
          total: result?.total || 0,
          page,
          pages: Math.max(1, result?.pages || 0)
        })
      }}</span>
      <div class="flex items-center gap-2">
        <label class="sr-only" for="trace-page-size">{{
          t('admin.modeltrace.history.pageSize')
        }}</label
        ><select
          id="trace-page-size"
          v-model.number="pageSize"
          class="input w-20"
          :disabled="loading"
          @change="changePageSize"
        >
          <option v-for="size in [10, 20, 50, 100]" :key="size" :value="size">
            {{ size }}
          </option></select
        ><button
          type="button"
          class="btn btn-secondary"
          :disabled="loading || page <= 1"
          @click="changePage(-1)"
        >
          {{ t('admin.modeltrace.previous') }}</button
        ><button
          type="button"
          class="btn btn-secondary"
          :disabled="loading || page >= (result?.pages || 1)"
          @click="changePage(1)"
        >
          {{ t('admin.modeltrace.next') }}
        </button>
      </div>
    </div>
    <BaseDialog
      :show="!!detailId"
      :title="t('admin.modeltrace.history.detailTitle')"
      width="wide"
      @close="closeDetail"
    >
      <p v-if="detailLoading" role="status" class="text-sm text-gray-500">
        {{ t('admin.modeltrace.loading') }}
      </p>
      <p v-if="detailError" role="alert" class="text-sm text-red-600">
        {{ detailError }}
        <button type="button" class="underline" @click="fetchDetail">
          {{ t('admin.modeltrace.retry') }}
        </button>
      </p>
      <div v-if="detail" class="space-y-5 text-sm">
        <p
          class="rounded-lg bg-amber-50 p-3 text-amber-800 dark:bg-amber-900/20 dark:text-amber-300"
        >
          {{ t('admin.modeltrace.disclaimer') }}
        </p>
        <dl class="grid gap-4 sm:grid-cols-2">
          <div>
            <dt class="text-gray-500">
              {{ t('admin.modeltrace.history.runId') }}
            </dt>
            <dd class="mt-1 break-all font-mono text-xs">{{ detail.id }}</dd>
          </div>
          <div>
            <dt class="text-gray-500">
              {{ t('admin.modeltrace.history.account') }}
            </dt>
            <dd class="mt-1 break-all font-mono text-xs">
              {{ detail.account_id }}
            </dd>
          </div>
          <div>
            <dt class="text-gray-500">
              {{ t('admin.modeltrace.history.status') }}
            </dt>
            <dd class="mt-1">
              {{ t(`admin.modeltrace.status.${detail.status}`) }}
            </dd>
          </div>
          <div>
            <dt class="text-gray-500">
              {{ t('admin.modeltrace.history.expected') }}
            </dt>
            <dd class="mt-1">{{ detail.expected_model || detail.model }}</dd>
          </div>
          <div>
            <dt class="text-gray-500">
              {{ t('admin.modeltrace.history.candidate') }}
            </dt>
            <dd class="mt-1">{{ detail.result?.prediction || '—' }}</dd>
          </div>
          <div>
            <dt class="text-gray-500">
              {{ t(detail.result?.method?.startsWith('shared-') ? 'admin.modeltrace.history.probability' : 'admin.modeltrace.history.similarity') }}
            </dt>
            <dd class="mt-1">{{ percent(detail.result?.confidence) }}</dd>
          </div>
          <div>
            <dt class="text-gray-500">
              {{ t('admin.modeltrace.history.samples') }}
            </dt>
            <dd class="mt-1">
              {{ detail.result?.used_outputs ?? detail.samples?.length ?? 0 }} /
              {{ detail.sample_count }}
            </dd>
          </div>
          <div>
            <dt class="text-gray-500">
              {{ t('admin.modeltrace.history.duration') }}
            </dt>
            <dd class="mt-1">
              {{
                detail.duration_ms == null ? '—' : `${detail.duration_ms} ms`
              }}
            </dd>
          </div>
          <div>
            <dt class="text-gray-500">
              {{ t('admin.modeltrace.history.selection') }}
            </dt>
            <dd class="mt-1">
              {{
                detail.model_selection
                  ? t(
                      `admin.modeltrace.selection.${detail.model_selection.source}`
                    )
                  : '—'
              }}
            </dd>
          </div>
          <div>
            <dt class="text-gray-500">
              {{ t('admin.modeltrace.history.action') }}
            </dt>
            <dd class="mt-1">
              {{ t(`admin.modeltrace.actions.${detail.applied_action}`) }}
            </dd>
          </div>
        </dl>
        <p
          v-if="detail.progress && isTraceActive(detail.status)"
          role="status"
          class="rounded-lg bg-gray-50 p-3 text-gray-700 dark:bg-dark-800 dark:text-dark-200"
        >
          {{ t('admin.modeltrace.history.progress', { completed: detail.progress.completed_samples, total: detail.progress.total_samples }) }}
          <span v-if="detail.progress.sample_index">
            {{ t('admin.modeltrace.history.currentSample', { index: detail.progress.sample_index }) }}
          </span>
        </p>
        <div
          v-if="detail.error"
          role="alert"
          class="space-y-3 rounded-lg bg-red-50 p-3 text-red-700 dark:bg-red-900/20 dark:text-red-400"
        >
          <p class="font-medium">{{ runErrorMessage(detail.error) }}</p>
          <dl class="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
            <div v-if="detail.error.sample_index">
              <dt>{{ t('admin.modeltrace.history.failureSample') }}</dt>
              <dd class="mt-1 tabular-nums">{{ detail.error.sample_index }} / {{ detail.sample_count }}</dd>
            </div>
            <div v-if="detail.error.http_status != null">
              <dt>{{ t('admin.modeltrace.history.httpStatus') }}</dt>
              <dd class="mt-1 tabular-nums">{{ detail.error.http_status }}</dd>
            </div>
            <div v-if="detail.error.sample_duration_ms != null">
              <dt>{{ t('admin.modeltrace.history.sampleDuration') }}</dt>
              <dd class="mt-1 tabular-nums">{{ detail.error.sample_duration_ms }} ms</dd>
            </div>
            <div v-if="detail.error.timeout_ms != null">
              <dt>{{ t('admin.modeltrace.history.sampleTimeout') }}</dt>
              <dd class="mt-1 tabular-nums">{{ detail.error.timeout_ms }} ms</dd>
            </div>
          </dl>
          <details class="text-xs">
            <summary class="cursor-pointer">{{ t('admin.modeltrace.history.diagnostics') }}</summary>
            <dl class="mt-2 space-y-2 break-all">
              <div><dt>{{ t('admin.modeltrace.history.errorCode') }}</dt><dd class="font-mono">{{ detail.error.code }}</dd></div>
              <div v-if="detail.error.challenge_id"><dt>{{ t('admin.modeltrace.history.challenge') }}</dt><dd class="font-mono">{{ detail.error.challenge_id }}</dd></div>
              <div v-if="detail.error.network_code"><dt>{{ t('admin.modeltrace.history.networkCode') }}</dt><dd class="font-mono">{{ detail.error.network_code }}</dd></div>
              <div v-if="detail.error.response_state"><dt>{{ t('admin.modeltrace.history.responseState') }}</dt><dd class="font-mono">{{ detail.error.response_state }}</dd></div>
            </dl>
          </details>
          <p class="text-sm">{{ t(detail.error.phase === 'action' ? 'admin.modeltrace.history.actionFailureGuide' : 'admin.modeltrace.history.failureGuide') }}</p>
        </div>
        <p
          v-if="detail.action_skipped_reason"
          class="rounded-lg bg-amber-50 p-3 text-amber-800 dark:bg-amber-900/20 dark:text-amber-300"
        >
          {{ detail.action_skipped_reason }}
        </p>
        <div v-if="detail.result?.scores?.length">
          <h3 class="mb-2 font-medium">
            {{ t('admin.modeltrace.history.scores') }}
          </h3>
          <ul class="divide-y divide-gray-100 dark:divide-dark-700">
            <li
              v-for="score in detail.result.scores"
              :key="score.model"
              class="flex justify-between gap-3 py-2"
            >
              <span>{{ score.model }}</span
              ><span class="tabular-nums"
                >{{ percent(score.score) }} ·
                {{
                  t('admin.modeltrace.history.scoreSamples', {
                    count: score.samples
                  })
                }}</span
              >
            </li>
          </ul>
        </div>
        <details v-if="detail.samples?.length">
          <summary class="cursor-pointer font-medium">
            {{ t('admin.modeltrace.history.sampleMetadata') }}
          </summary>
          <ul class="mt-2 space-y-2">
            <li
              v-for="sample in detail.samples"
              :key="sample.challenge_id"
              class="rounded-lg bg-gray-50 p-3 dark:bg-dark-800"
            >
              <p>
                {{ sample.challenge_id }} ·
                {{
                  t('admin.modeltrace.history.characters', {
                    count: sample.length
                  })
                }}
              </p>
              <p class="mt-1 break-all font-mono text-xs text-gray-500">
                SHA-256: {{ sample.sha256 }}
              </p>
              <p v-if="sample.duration_ms != null" class="mt-1 text-xs tabular-nums text-gray-500">
                {{ t('admin.modeltrace.history.sampleDuration') }}: {{ sample.duration_ms }} ms
              </p>
            </li>
          </ul>
        </details>
      </div>
      <template #footer
        ><div class="flex justify-end gap-3">
          <button
            v-if="detail && isTraceActive(detail.status)"
            type="button"
            class="btn btn-secondary text-red-600"
            :disabled="canceling"
            @click="pendingCancel = detail"
          >
            {{ t('admin.modeltrace.history.cancel') }}</button
          ><button type="button" class="btn btn-secondary" @click="closeDetail">
            {{ t('admin.modeltrace.close') }}
          </button>
        </div></template
      >
    </BaseDialog>
    <ConfirmDialog
      :show="!!pendingCancel"
      :title="t('admin.modeltrace.history.cancelTitle')"
      :message="
        t('admin.modeltrace.history.cancelConfirm', {
          id: pendingCancel?.id || ''
        })
      "
      danger
      @cancel="pendingCancel = null"
      @confirm="cancelRun"
    />
  </section>
</template>
