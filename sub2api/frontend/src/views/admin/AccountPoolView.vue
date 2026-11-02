<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import AppLayout from '@/components/layout/AppLayout.vue'
import TablePageLayout from '@/components/layout/TablePageLayout.vue'
import Pagination from '@/components/common/Pagination.vue'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'
import AccountPoolAccountDialog from '@/components/admin/account-pool/AccountPoolAccountDialog.vue'
import AccountPoolGroupsDialog from '@/components/admin/account-pool/AccountPoolGroupsDialog.vue'
import { getIntegrationPoolStats, listIntegrationAccounts, listIntegrationGroups, runIntegrationAccountAction, type IntegrationAccount, type IntegrationAccountAction, type IntegrationGroup, type IntegrationPoolStats } from '@/api/admin/integrationAccounts'
import { integrationErrorMessage } from '@/api/admin/integrationClient'
const { t } = useI18n()
const accounts = shallowRef<IntegrationAccount[]>([])
const groups = shallowRef<IntegrationGroup[]>([])
const stats = shallowRef<IntegrationPoolStats | null>(null)
const filters = reactive({ search: '', status: '', mode: '', group_id: '' })
const page = shallowRef(1)
const pageSize = shallowRef(20)
const total = shallowRef(0)
const loading = shallowRef(false)
const error = shallowRef('')
const feedback = shallowRef('')
const showAccountDialog = shallowRef(false)
const showGroups = shallowRef(false)
const editingAccount = shallowRef<IntegrationAccount | null>(null)
const confirmation = shallowRef<{ account: IntegrationAccount; action: IntegrationAccountAction } | null>(null)
const runningAction = shallowRef<{ id: string; action: IntegrationAccountAction } | null>(null)
const statKeys = ['total', 'available', 'busy', 'blocked'] as const
const columns = ['account', 'status', 'capacity', 'egress', 'actions'] as const
const statuses = ['ready', 'provisioning', 'error', 'deleting'] as const
const groupNames = computed(() => new Map(groups.value.map(group => [group.id, group.name])))
let loadController: AbortController | undefined
let actionController: AbortController | undefined
let loadGeneration = 0
let disposed = false
let debounceTimer: ReturnType<typeof setTimeout> | undefined
function lifecycleLocked(account: IntegrationAccount) { return account.deletion_pending || ['provisioning', 'deleting'].includes(account.status) }
function visibleActions(account: IntegrationAccount): IntegrationAccountAction[] {
  if (account.deletion_pending) return ['retry-delete']
  return ['sync', ...((account.slot_binding_stale || ['error', 'provisioning'].includes(account.status)) ? ['retry' as const] : []), 'delete']
}
function canRun(account: IntegrationAccount, action: IntegrationAccountAction) {
  if (action === 'sync') return !!account.vm_id && !account.deletion_pending && account.status !== 'deleting'
  if (account.dispatch.inflight_requests > 0) return false
  if (action === 'retry-delete') return account.deletion_pending
  if (action === 'retry') return !account.deletion_pending && (account.slot_binding_stale || ['error', 'provisioning'].includes(account.status))
  return !lifecycleLocked(account)
}
function cooldownUntil(account: IntegrationAccount) {
  const values = [account.dispatch.rate_limited_until, account.dispatch.overload_until, account.dispatch.temp_unschedulable_until]
    .filter((value): value is string => !!value && Date.parse(value) > Date.now()).sort((a, b) => Date.parse(b) - Date.parse(a))
  return values[0] ? new Date(values[0]).toLocaleString() : ''
}
async function load() {
  clearTimeout(debounceTimer)
  loadController?.abort()
  loadController = new AbortController()
  const signal = loadController.signal
  const current = ++loadGeneration
  loading.value = true; error.value = ''
  try {
    const [result, groupList, poolStats] = await Promise.all([
      listIntegrationAccounts({ page: page.value, page_size: pageSize.value, search: filters.search.trim() || undefined, status: filters.status || undefined, mode: filters.mode || undefined, group_id: filters.group_id || undefined }, signal),
      listIntegrationGroups(signal),
      getIntegrationPoolStats({ mode: filters.mode || undefined, group_id: filters.group_id || undefined }, signal)
    ])
    if (disposed || current !== loadGeneration || signal.aborted) return
    if (result.total > 0 && page.value > result.pages) { page.value = Math.max(1, result.pages); return }
    accounts.value = result.items; total.value = result.total; groups.value = groupList; stats.value = poolStats
  } catch (cause) {
    if (disposed || current !== loadGeneration || signal.aborted) return
    error.value = integrationErrorMessage(cause, t('admin.accountPool.loadError'))
    accounts.value = []; total.value = 0; stats.value = null
  } finally { if (!disposed && current === loadGeneration) loading.value = false }
}
watch(() => [filters.search, filters.status, filters.mode, filters.group_id], (next, previous) => {
  page.value = 1
  clearTimeout(debounceTimer)
  // Invalidate in-flight responses immediately, including during the search debounce.
  ++loadGeneration; loadController?.abort()
  debounceTimer = setTimeout(() => { void load() }, next[0] !== previous[0] ? 300 : 0)
})
watch([page, pageSize], () => { void load() })
function changePageSize(value: number) { pageSize.value = Math.min(200, value); page.value = 1 }
function openImport() { editingAccount.value = null; showAccountDialog.value = true }
function openEdit(account: IntegrationAccount) { editingAccount.value = account; showAccountDialog.value = true }
function closeAccountDialog(interrupted: boolean) { showAccountDialog.value = false; editingAccount.value = null; if (interrupted) feedback.value = t('admin.accountPool.requestUnknown'); void load() }
function closeGroups(interrupted: boolean) { showGroups.value = false; if (interrupted) { feedback.value = t('admin.accountPool.requestUnknown'); void load() } }
function onSaved() { feedback.value = t(editingAccount.value ? 'admin.accountPool.saved' : 'admin.accountPool.imported') }
async function performAction() {
  const selected = confirmation.value
  if (!selected || runningAction.value || !canRun(selected.account, selected.action)) return
  confirmation.value = null
  runningAction.value = { id: selected.account.id, action: selected.action }
  feedback.value = ''; error.value = ''
  actionController = new AbortController()
  const signal = actionController.signal
  try {
    const result = await runIntegrationAccountAction(selected.account.id, selected.action, signal)
    if (disposed || signal.aborted) return
    if ('error' in result && result.error) feedback.value = result.error.message
    else feedback.value = t('admin.accountPool.done')
  } catch (cause) {
    if (disposed || signal.aborted) return
    feedback.value = integrationErrorMessage(cause, t('admin.accountPool.operationError'))
  } finally {
    if (!disposed) { runningAction.value = null; await load() }
  }
}
onMounted(load)
onBeforeUnmount(() => { disposed = true; ++loadGeneration; clearTimeout(debounceTimer); loadController?.abort(); actionController?.abort() })
</script>

<template>
  <AppLayout>
    <TablePageLayout>
      <template #actions>
        <div class="console-heading flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 class="text-2xl font-semibold text-gray-900 dark:text-white">{{ t('admin.accountPool.title') }}</h1>
            <p class="mt-1 text-sm text-gray-500">{{ t('admin.accountPool.description') }}</p>
          </div>
          <div class="flex flex-wrap gap-2">
            <button type="button" class="btn btn-secondary" :disabled="loading" @click="load">{{ t('admin.accountPool.refresh') }}</button>
            <button type="button" class="btn btn-secondary" :disabled="loading || !!error || !!runningAction" @click="showGroups = true">{{ t('admin.accountPool.groups') }}</button>
            <button type="button" class="btn btn-primary" :disabled="loading || !!error || !!runningAction" @click="openImport">{{ t('admin.accountPool.import') }}</button>
          </div>
        </div>
        <p v-if="error" role="alert" class="mt-3 rounded-xl bg-red-50 p-3 text-sm text-red-700 dark:bg-red-900/20 dark:text-red-300">{{ error }}</p>
        <p v-if="feedback" role="status" class="mt-3 text-sm text-gray-600 dark:text-gray-300">{{ feedback }}</p>
        <dl class="pool-stat-strip">
          <div v-for="key in statKeys" :key="key" class="pool-stat">
            <dt class="text-xs text-gray-500 dark:text-dark-300">{{ t(`admin.accountPool.${key}`) }}</dt>
            <dd class="mt-1">{{ stats?.[key] ?? '—' }}</dd>
          </div>
        </dl>
        <p class="isolation-note">{{ t('admin.accountPool.isolationSummary') }}</p>
        <p class="mt-2 text-xs text-gray-500">{{ t('admin.accountPool.statsScope') }}</p>
      </template>
      <template #filters>
        <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <input v-model="filters.search" class="input lg:col-span-2" type="search" maxlength="120" :placeholder="t('admin.accountPool.search')" :aria-label="t('admin.accountPool.search')" />
          <select v-model="filters.status" class="input" :aria-label="t('admin.accountPool.status')">
            <option value="">{{ t('admin.accountPool.allStatuses') }}</option>
            <option v-for="status in statuses" :key="status" :value="status">{{ t(`admin.accountPool.${status}`) }}</option>
          </select>
          <select v-model="filters.mode" class="input" :aria-label="t('admin.accountPool.mode')">
            <option value="">{{ t('admin.accountPool.allModes') }}</option>
            <option value="pool">{{ t('admin.accountPool.pool') }}</option><option value="lease">{{ t('admin.accountPool.lease') }}</option>
          </select>
          <select v-model="filters.group_id" class="input" :aria-label="t('admin.accountPool.groupBinding')">
            <option value="">{{ t('admin.accountPool.allGroups') }}</option>
            <option v-for="group in groups" :key="group.id" :value="group.id">{{ group.name }}</option>
          </select>
        </div>
      </template>
      <template #table>
        <div class="table-wrapper" tabindex="0" :aria-label="t('admin.accountPool.title')" :aria-busy="loading">
          <table>
            <thead><tr>
              <th v-for="column in columns" :key="column" scope="col">{{ t(`admin.accountPool.${column}`) }}</th>
            </tr></thead>
            <tbody>
              <tr v-if="loading && accounts.length === 0"><td colspan="5" class="text-center">{{ t('admin.accountPool.loading') }}</td></tr>
              <tr v-else-if="error"><td colspan="5" class="text-center">{{ t('admin.accountPool.loadError') }}</td></tr>
              <tr v-else-if="accounts.length === 0"><td colspan="5" class="py-12 text-center"><p class="text-pretty text-gray-600 dark:text-dark-300">{{ t('admin.accountPool.empty') }}</p><button type="button" class="btn btn-primary mt-4" @click="openImport">{{ t('admin.accountPool.import') }}</button></td></tr>
              <tr v-for="account in accounts" :key="account.id" :data-account-id="account.id">
                <td class="max-w-64">
                  <p class="break-words font-medium">{{ account.name }}</p>
                  <p class="mt-1 break-all font-mono text-xs text-gray-500">{{ account.id }}</p>
                  <p class="mt-2 text-xs">{{ t(`admin.accountPool.${account.mode}`) }}</p>
                  <div class="mt-1 flex flex-wrap gap-1">
                    <span v-for="id in account.group_ids" :key="id" class="rounded bg-gray-100 px-1.5 py-0.5 text-xs dark:bg-dark-700">{{ groupNames.get(id) || id }}</span>
                    <span v-if="!account.group_ids.length" class="text-xs text-amber-600">{{ t('admin.accountPool.unassigned') }}</span>
                  </div>
                </td>
                <td class="max-w-72">
                  <span :class="account.status === 'ready' ? 'text-emerald-700 dark:text-emerald-300' : account.status === 'error' ? 'text-red-700 dark:text-red-300' : 'text-gray-500'">{{ t(`admin.accountPool.${account.status}`) }}</span>
                  <p class="mt-1 text-xs">{{ t(account.schedulable ? 'admin.accountPool.schedulable' : 'admin.accountPool.paused') }}</p>
                  <p v-if="account.slot_binding_stale" class="mt-1 text-xs text-amber-700 dark:text-amber-300">{{ t('admin.accountPool.stale') }}</p>
                  <p v-if="account.deletion_pending" class="mt-1 text-xs text-red-600">{{ t('admin.accountPool.deletionPending') }}</p>
                  <p v-if="account.slot?.health?.ok === false" class="mt-1 text-xs text-red-600">{{ t('admin.accountPool.healthFailed') }}</p>
                  <p v-else-if="account.slot && account.slot.health?.ok == null" class="mt-1 text-xs text-gray-500">{{ t('admin.accountPool.healthUnknown') }}</p>
                  <p v-if="account.error" class="mt-1 break-words text-xs text-red-600 dark:text-red-300">{{ account.error.message }} <span class="font-mono">({{ account.error.code }})</span></p>
                  <p v-if="cooldownUntil(account)" class="mt-1 text-xs text-amber-700 dark:text-amber-300">{{ t('admin.accountPool.cooldown', { time: cooldownUntil(account) }) }}</p>
                </td>
                <td>
                  <p class="tabular-nums">{{ t('admin.accountPool.inflight', { used: account.dispatch.inflight_requests, limit: account.concurrency }) }}</p>
                  <p class="mt-1 text-xs text-gray-500">{{ t('admin.accountPool.priorityValue', { value: account.priority }) }}</p>
                </td>
                <td class="max-w-60">
                  <span class="slot-identity" :class="account.isolation?.slot_bound ? 'text-primary-700 dark:text-primary-300' : 'text-gray-500 dark:text-dark-300'">
                    <svg aria-hidden="true" class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M8 8h8M8 12h8M8 16h4" /></svg>
                    {{ t(account.isolation?.slot_bound ? 'admin.accountPool.isolatedSlot' : 'admin.accountPool.isolationPending') }}
                  </span>
                  <p class="break-all font-mono text-xs">{{ account.slot?.egress?.proxy_id || account.binding.proxy_id || t('admin.accountPool.unbound') }}</p>
                  <p class="mt-1 text-xs text-gray-500">{{ t('admin.accountPool.fixed') }} · {{ account.slot?.egress?.bound ? t('admin.accountPool.ready') : t('admin.accountPool.unbound') }}</p>
                  <p class="mt-2 break-all font-mono text-xs text-gray-500">{{ account.vm_id || t('admin.accountPool.noSlot') }}</p>
                  <details class="slot-details">
                    <summary>{{ t('admin.accountPool.isolationDetails') }}</summary>
                    <dl>
                      <div><dt>{{ t('admin.accountPool.slotOwner') }}</dt><dd>{{ account.id }}</dd></div>
                      <div><dt>{{ t('admin.accountPool.slotGeneration') }}</dt><dd class="tabular-nums">{{ account.provision_generation }}</dd></div>
                      <div><dt>{{ t('admin.accountPool.credentialBoundary') }}</dt><dd>{{ t('admin.accountPool.credentialPerAccount') }}</dd></div>
                      <div><dt>{{ t('admin.accountPool.sessionBoundary') }}</dt><dd>{{ t('admin.accountPool.sessionPerCaller') }}</dd></div>
                      <div><dt>{{ t('admin.accountPool.slotTimezone') }}</dt><dd>{{ account.slot?.egress?.timezone || account.binding.timezone || t('admin.accountPool.isolationPending') }}</dd></div>
                      <div><dt>{{ t('admin.accountPool.slotContainer') }}</dt><dd>{{ account.slot?.isolation?.container || t('admin.accountPool.runtimeNotReported') }}</dd></div>
                    </dl>
                  </details>
                </td>
                <td>
                  <div class="flex max-w-72 flex-wrap gap-2">
                    <button type="button" class="btn btn-secondary btn-sm" :disabled="!!runningAction || loading || lifecycleLocked(account)" @click="openEdit(account)">{{ t('admin.accountPool.edit') }}</button>
                    <button v-for="action in visibleActions(account)" :key="action" type="button" :data-action="action" class="btn btn-secondary btn-sm" :disabled="!!runningAction || loading || !canRun(account, action)" @click="confirmation = { account, action }">{{ t(`admin.accountPool.${action}`) }}</button>
                    <RouterLink :to="{ path: '/admin/modeltrace', query: { account_id: account.id } }" class="btn btn-ghost btn-sm">{{ t('admin.accountPool.modeltrace') }}</RouterLink>
                  </div>
                  <p v-if="runningAction?.id === account.id" role="status" class="mt-2 text-xs text-gray-500">{{ t('admin.accountPool.working') }}</p>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
      <template #pagination>
        <Pagination v-if="total > 0" :total="total" :page="page" :page-size="pageSize" :page-size-options="[20, 50, 100, 200]" @update:page="page = $event" @update:page-size="changePageSize" />
      </template>
    </TablePageLayout>
    <AccountPoolAccountDialog v-if="showAccountDialog" :show="showAccountDialog" :account="editingAccount" :groups="groups" @close="closeAccountDialog" @saved="onSaved" />
    <AccountPoolGroupsDialog v-if="showGroups" :show="showGroups" :groups="groups" @close="closeGroups" @changed="load" />
    <ConfirmDialog :show="!!confirmation" :title="t('admin.accountPool.confirmTitle')" :message="confirmation ? t('admin.accountPool.confirmAction', { name: confirmation.account.name, action: t(`admin.accountPool.${confirmation.action}`) }) : ''" :danger="confirmation?.action === 'delete' || confirmation?.action === 'retry-delete'" :confirm-text="t('admin.accountPool.confirm')" @cancel="confirmation = null" @confirm="performAction">
      <p class="text-sm text-gray-600 dark:text-gray-400">{{ confirmation ? t(confirmation.action === 'sync' ? 'admin.accountPool.confirmSync' : confirmation.action === 'retry' ? 'admin.accountPool.confirmRetry' : 'admin.accountPool.confirmDelete') : '' }}</p>
    </ConfirmDialog>
  </AppLayout>
</template>
