<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import AppLayout from '@/components/layout/AppLayout.vue'
import TracePolicyPanel from '@/components/admin/modeltrace/TracePolicyPanel.vue'
import TraceBankPanel from '@/components/admin/modeltrace/TraceBankPanel.vue'
import TraceAccountPanel from '@/components/admin/modeltrace/TraceAccountPanel.vue'
import TraceHistoryPanel from '@/components/admin/modeltrace/TraceHistoryPanel.vue'
import TraceAutomationPanel from '@/components/admin/modeltrace/TraceAutomationPanel.vue'
import {
  modeltraceApi,
  type TraceSummary
} from '@/api/admin/integrationModeltrace'
import { integrationErrorMessage } from '@/api/admin/integrationClient'
const { t, locale } = useI18n(),
  route = useRoute()
const summary = shallowRef<TraceSummary | null>(null),
  loading = ref(false),
  error = ref(''),
  refreshKey = ref(0)
const initialAccount = computed(() =>
  typeof route.query.account_id === 'string' ? route.query.account_id : ''
)
const selectedAccount = shallowRef(initialAccount.value)
watch(initialAccount, (id) => { selectedAccount.value = id })
const totalRuns = computed(() =>
  Object.values(summary.value?.run_counts || {}).reduce(
    (sum, count) => sum + (count || 0),
    0
  )
)
const enabledAccounts = computed(
  () => summary.value?.accounts.filter((account) => account.enabled).length || 0
)
const automaticMonitoring = computed(() => summary.value?.config.enabled &&
  summary.value.accounts.some((account) => account.automation?.enabled && account.automation.trigger !== 'manual'))
let disposed = false,
  generation = 0,
  timer: ReturnType<typeof setTimeout> | undefined,
  controller: AbortController | undefined
async function refresh() {
  clearTimeout(timer)
  controller?.abort()
  controller = new AbortController()
  const request = ++generation
  loading.value = true
  error.value = ''
  try {
    const value = await modeltraceApi.summary(controller.signal)
    if (disposed || request !== generation) return
    summary.value = value
    refreshKey.value++
    if (value.active_runs > 0) timer = setTimeout(refresh, 5000)
    else if (automaticMonitoring.value) timer = setTimeout(refresh, 15000)
  } catch (cause) {
    if (!disposed && request === generation)
      error.value = integrationErrorMessage(
        cause,
        t('admin.modeltrace.requestFailed')
      )
  } finally {
    if (!disposed && request === generation) loading.value = false
  }
}
onMounted(refresh)
onUnmounted(() => {
  disposed = true
  generation++
  clearTimeout(timer)
  controller?.abort()
})
</script>

<template>
  <AppLayout>
      <div class="space-y-6">
        <div class="console-heading flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 class="text-2xl font-bold text-gray-900 dark:text-white">
            {{ t('admin.modeltrace.title') }}
          </h1>
          <p class="mt-1 text-sm text-gray-500 dark:text-dark-400">
            {{ t('admin.modeltrace.description') }}
          </p>
        </div>
        <button
          type="button"
          class="btn btn-secondary"
          :disabled="loading"
          @click="refresh"
        >
          {{
            t(loading ? 'admin.modeltrace.loading' : 'admin.modeltrace.refresh')
          }}
        </button>
      </div>
      <p
        class="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-300"
      >
        {{ t('admin.modeltrace.disclaimer') }}
      </p>
      <div
        v-if="error"
        role="alert"
        class="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900 dark:bg-red-900/20 dark:text-red-400"
      >
        {{ error }}
        <button
          type="button"
          class="ml-2 underline"
          :disabled="loading"
          @click="refresh"
        >
          {{ t('admin.modeltrace.retry') }}
        </button>
      </div>
      <div
        v-if="!summary && loading"
        role="status"
        class="card p-10 text-center text-gray-500"
      >
        {{ t('admin.modeltrace.loading') }}
      </div>
      <template v-if="summary">
        <div v-if="summary.readiness && !summary.readiness.ready" role="status" class="rounded-xl bg-amber-50 p-4 text-sm text-amber-800 dark:bg-amber-900/20 dark:text-amber-300">
          <p class="font-medium">{{ t('admin.modeltrace.readiness.title') }}</p>
          <ul class="mt-2 list-inside list-disc">
            <li v-for="blocker in summary.readiness.blockers" :key="blocker">{{ t(`admin.modeltrace.readiness.${blocker}`) }}</li>
          </ul>
        </div>
        <div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <div class="card p-4">
            <p class="text-sm text-gray-500">
              {{ t('admin.modeltrace.summary.active') }}
            </p>
            <p class="mt-2 text-2xl font-semibold tabular-nums">
              {{ summary.active_runs }}
            </p>
          </div>
          <div class="card p-4">
            <p class="text-sm text-gray-500">
              {{ t('admin.modeltrace.summary.total') }}
            </p>
            <p class="mt-2 text-2xl font-semibold tabular-nums">
              {{ totalRuns }}
            </p>
          </div>
          <div class="card p-4">
            <p class="text-sm text-gray-500">
              {{ t('admin.modeltrace.summary.suspected') }}
            </p>
            <p class="mt-2 text-2xl font-semibold tabular-nums text-amber-600">
              {{ summary.run_counts.suspected_mismatch || 0 }}
            </p>
          </div>
          <div class="card p-4">
            <p class="text-sm text-gray-500">
              {{ t('admin.modeltrace.summary.accounts') }}
            </p>
            <p class="mt-2 text-2xl font-semibold tabular-nums">
              {{ enabledAccounts }} / {{ summary.accounts.length }}
            </p>
          </div>
        </div>
        <p class="text-xs text-gray-500">
          {{
            t('admin.modeltrace.summary.updated', {
              time: new Date(summary.as_of).toLocaleString(locale)
            })
          }}
          <span v-if="summary.active_runs > 0"
            >· {{ t('admin.modeltrace.summary.polling') }}</span
          >
          <span v-else-if="automaticMonitoring">· {{ t('admin.modeltrace.summary.monitoring') }}</span>
        </p>
        <TraceAutomationPanel
          :accounts="summary.accounts"
          :global-enabled="summary.config.enabled"
          :usage-bridge="summary.usage_bridge"
          @selected="selectedAccount = $event"
        />
        <div class="grid items-start gap-6 xl:grid-cols-2">
          <TracePolicyPanel
            :config="summary.config"
            @changed="refresh"
          /><TraceBankPanel :bank="summary.bank" @changed="refresh" />
        </div>
        <TraceAccountPanel
          :accounts="summary.accounts"
          :bank-ready="summary.bank.ready"
          :refresh-key="refreshKey"
          :initial-account="selectedAccount"
          :global-enabled="summary.config.enabled"
          @changed="refresh"
          @selected="selectedAccount = $event"
        />
        <TraceHistoryPanel
          :accounts="summary.accounts"
          :refresh-key="refreshKey"
          :initial-account="selectedAccount"
          @changed="refresh"
        />
      </template>
    </div>
  </AppLayout>
</template>
