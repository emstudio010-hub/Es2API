<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type {
  TraceAccountSummary,
  TraceUsageBridge
} from '@/api/admin/integrationModeltrace'

const props = defineProps<{
  accounts: TraceAccountSummary[]
  globalEnabled: boolean
  usageBridge?: TraceUsageBridge
}>()
const emit = defineEmits<{ selected: [id: string] }>()
const { t, locale } = useI18n()
const rows = computed(() => props.accounts.map((account) => {
  const automation = account.automation
  const state = automation?.active_run_id ? 'running'
    : !automation ? 'unknown'
      : !automation.ready ? 'blocked'
        : (automation.cooldown_remaining_seconds || 0) > 0 ? 'cooling' : 'waiting'
  return { ...account, state }
}))
function time(value?: string | null) {
  return value ? new Date(value).toLocaleString(locale.value) : t('admin.modeltrace.automation.noUsage')
}
</script>

<template>
  <section class="card overflow-hidden" aria-labelledby="trace-automation-title">
    <div class="space-y-3 p-5">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <h2 id="trace-automation-title" class="text-lg font-semibold">
          {{ t('admin.modeltrace.automation.title') }}
        </h2>
        <span class="rounded-full bg-gray-100 px-3 py-1 text-sm dark:bg-dark-700">
          {{ t(globalEnabled ? 'admin.modeltrace.automation.globalOn' : 'admin.modeltrace.automation.globalOff') }}
        </span>
      </div>
      <p class="text-sm text-gray-500 dark:text-dark-400">
        {{ t('admin.modeltrace.automation.description') }}
      </p>
      <p v-if="usageBridge" role="status" class="text-sm" :class="usageBridge.configured ? 'text-gray-500' : 'text-amber-600'">
        {{ t(usageBridge.configured ? 'admin.modeltrace.automation.bridgeReady' : 'admin.modeltrace.automation.bridgeMissing') }}
        <span v-if="usageBridge.last_event_at"> · {{ t('admin.modeltrace.automation.lastEvent', { time: time(usageBridge.last_event_at) }) }}</span>
      </p>
    </div>
    <p v-if="!rows.length" class="px-5 pb-5 text-sm text-gray-500">{{ t('admin.modeltrace.account.empty') }}</p>
    <div v-else class="overflow-x-auto" tabindex="0" :aria-label="t('admin.modeltrace.automation.title')">
      <table class="w-full text-left text-sm">
        <thead class="border-y border-gray-100 bg-gray-50 text-gray-500 dark:border-dark-700 dark:bg-dark-800">
          <tr>
            <th scope="col" class="px-5 py-3 font-medium">{{ t('admin.modeltrace.history.account') }}</th>
            <th scope="col" class="px-5 py-3 font-medium">{{ t('admin.modeltrace.automation.state') }}</th>
            <th scope="col" class="px-5 py-3 font-medium">{{ t('admin.modeltrace.automation.progress') }}</th>
            <th scope="col" class="px-5 py-3 font-medium">{{ t('admin.modeltrace.automation.lastUsage') }}</th>
            <th scope="col" class="px-5 py-3 font-medium">{{ t('admin.modeltrace.account.latest') }}</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-gray-100 dark:divide-dark-700">
          <tr v-for="account in rows" :key="account.account_id">
            <td class="px-5 py-4">
              <button type="button" class="break-all text-left font-medium text-primary-600 underline decoration-transparent hover:decoration-current" @click="emit('selected', account.account_id)">
                {{ account.account_id }}
              </button>
            </td>
            <td class="min-w-48 px-5 py-4">
              <p :class="account.state === 'blocked' ? 'text-amber-600' : ''">{{ t(`admin.modeltrace.automation.${account.state}`) }}</p>
              <p v-if="account.automation?.cooldown_until && (account.automation.cooldown_remaining_seconds || 0) > 0" class="mt-1 text-xs text-gray-500">{{ t('admin.modeltrace.automation.cooldownUntil', { time: time(account.automation.cooldown_until) }) }}</p>
              <ul v-if="account.automation?.blocked_reasons.length && !account.automation.active_run_id" class="mt-1 space-y-1 text-xs text-gray-500">
                <li v-for="reason in account.automation.blocked_reasons" :key="reason">{{ t(`admin.modeltrace.readiness.${reason}`) }}</li>
              </ul>
            </td>
            <td class="min-w-48 px-5 py-4 tabular-nums">
              <template v-if="account.automation">
                <p class="mb-1 font-medium">{{ t(`admin.modeltrace.triggers.${account.automation.trigger}`) }}</p>
                <p v-if="account.automation.remaining_requests !== null">
                  {{ t('admin.modeltrace.automation.requestProgress', { count: account.automation.successful_since_check, total: account.automation.every_requests }) }}
                </p>
                <p v-if="account.automation.remaining_requests !== null" class="mt-1 text-xs text-gray-500">
                  {{ t('admin.modeltrace.automation.remaining', { count: account.automation.remaining_requests }) }}
                </p>
                <p v-if="account.automation.next_due" class="mt-1 text-xs text-gray-500">
                  {{ t('admin.modeltrace.automation.nextDue', { time: time(account.automation.next_due) }) }}
                </p>
                <p v-if="account.automation.trigger === 'active_interval'" class="mt-1 text-xs text-gray-500">{{ t('admin.modeltrace.automation.activeRequired', { count: account.automation.successful_since_check }) }}</p>
                <p v-if="account.automation.trigger === 'requests_and_interval'" class="mt-1 text-xs text-gray-500">{{ t('admin.modeltrace.automation.bothRequired') }}</p>
                <p v-if="account.automation.trigger === 'probability'" class="mt-1 text-xs text-gray-500">{{ t('admin.modeltrace.automation.probability', { percent: (account.automation.sampling_probability ?? 0.1) * 100 }) }}</p>
                <template v-if="account.automation.trigger === 'idle_return'">
                  <p class="mt-1 text-xs text-gray-500">{{ t('admin.modeltrace.automation.idleRequired', { minutes: (account.automation.idle_seconds ?? 1800) / 60 }) }}</p>
                  <p v-if="account.automation.idle_due_at" class="mt-1 text-xs text-gray-500">{{ t('admin.modeltrace.automation.idleDue', { time: time(account.automation.idle_due_at) }) }}</p>
                </template>
              </template>
              <span v-else>—</span>
            </td>
            <td class="whitespace-nowrap px-5 py-4 text-gray-500">{{ time(account.automation?.last_usage_at) }}</td>
            <td class="whitespace-nowrap px-5 py-4">{{ account.last_status ? t(`admin.modeltrace.status.${account.last_status}`) : '—' }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>
