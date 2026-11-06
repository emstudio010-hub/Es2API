<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import AppLayout from '@/components/layout/AppLayout.vue'
import TablePageLayout from '@/components/layout/TablePageLayout.vue'
import Pagination from '@/components/common/Pagination.vue'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'
import AccountPoolAccountDialog from '@/components/admin/account-pool/AccountPoolAccountDialog.vue'
import ExitResourcesDialog from '@/components/admin/account-pool/ExitResourcesDialog.vue'
import AccountPoolPublishPanel from '@/components/admin/account-pool/AccountPoolPublishPanel.vue'
import { getIntegrationAccount, getIntegrationPoolStats, listIntegrationAccounts, listIntegrationGroups, runIntegrationAccountAction, type IntegrationAccount, type IntegrationAccountAction, type IntegrationGroup, type IntegrationPoolStats } from '@/api/admin/integrationAccounts'
import { integrationErrorMessage } from '@/api/admin/integrationClient'
const props = withDefaults(defineProps<{ surface?: 'accounts' | 'pools'; workspaceId?: string }>(), { surface: 'pools', workspaceId: '' })
const { t } = useI18n()
const isPoolList = computed(() => props.surface === 'pools' && !props.workspaceId)
const workspaceSection = shallowRef<'instance' | 'ip' | 'settings'>('instance')
const heading = computed(() => props.workspaceId ? accounts.value[0]?.name || t('admin.accountPool.workspace') : t(props.surface === 'accounts' ? 'admin.accountPool.accountsTitle' : 'admin.accountPool.title'))
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
const showExits = shallowRef(false)
const editingAccount = shallowRef<IntegrationAccount | null>(null)
const confirmation = shallowRef<{ account: IntegrationAccount; action: IntegrationAccountAction } | null>(null)
const runningAction = shallowRef<{ id: string; action: IntegrationAccountAction } | null>(null)
const statKeys = ['total', 'available', 'busy', 'blocked'] as const
const columns = computed(() => props.surface === 'accounts' ? ['account', 'status', 'actions'] : ['account', 'status', 'capacity', 'egress', 'actions'])
const statuses = ['ready', 'stopped', 'provisioning', 'error', 'deleting'] as const
const confirmMessages: Record<IntegrationAccountAction, string> = {
  sync: 'confirmSync', retry: 'confirmRetry', 'retry-delete': 'confirmDelete', delete: 'confirmDelete',
  start: 'confirmStart', stop: 'confirmStop', recover: 'confirmRecover', 'recover-credential': 'confirmRecoverCredential'
}
const groupNames = computed(() => new Map(groups.value.map(group => [group.id, group.name])))
let loadController: AbortController | undefined
let actionController: AbortController | undefined
let loadGeneration = 0
let disposed = false
let debounceTimer: ReturnType<typeof setTimeout> | undefined
let refreshTimer: ReturnType<typeof setTimeout> | undefined
function lifecycleLocked(account: IntegrationAccount) { return account.deletion_pending || ['provisioning', 'deleting'].includes(account.status) }
function refreshPending(account: IntegrationAccount) { return account.slot?.credential_refresh_pending === true || account.error?.code === 'codex_refresh_recovery_required' }
function stateCheckedAt(account: IntegrationAccount) {
  const at = account.dispatch.last_health_check_at
  return at ? new Date(at).toLocaleString() : t('admin.accountPool.notSynced')
}
function visibleActions(account: IntegrationAccount): IntegrationAccountAction[] {
  if (refreshPending(account)) return ['sync', ...(props.workspaceId && !account.deletion_pending ? ['stop' as const] : [])]
  if (account.deletion_pending) return ['retry-delete']
  const power: IntegrationAccountAction[] = account.vm_id && props.workspaceId && !lifecycleLocked(account) ? [account.slot?.status === 'running' ? 'stop' : 'start', 'recover'] : []
  return ['sync', ...power, ...((account.slot_binding_stale || ['error', 'provisioning'].includes(account.status)) ? ['retry' as const] : []), 'delete']
}
function canRun(account: IntegrationAccount, action: IntegrationAccountAction) {
  if (action === 'recover-credential') return !!props.workspaceId && !!account.vm_id && refreshPending(account) && account.dispatch.inflight_requests === 0 && !['provisioning', 'deleting'].includes(account.status) && !account.binding.credential_handoff
  if (action === 'sync') return !!account.vm_id && !['provisioning', 'deleting'].includes(account.status)
  if (refreshPending(account) && action !== 'stop') return false
  if (['start', 'stop', 'recover'].includes(action)) return !!account.vm_id && !lifecycleLocked(account) && (action === 'stop' || !account.slot_binding_stale) && (action !== 'start' || account.dispatch.inflight_requests === 0)
  if (account.dispatch.inflight_requests > 0) return false
  if (action === 'retry-delete') return account.deletion_pending
  if (action === 'retry') return !lifecycleLocked(account) && (account.slot_binding_stale || account.status === 'error')
  return !lifecycleLocked(account)
}
function cooldownUntil(account: IntegrationAccount) {
  const values = [account.dispatch.rate_limited_until, account.dispatch.overload_until, account.dispatch.temp_unschedulable_until]
    .filter((value): value is string => !!value && Date.parse(value) > Date.now()).sort((a, b) => Date.parse(b) - Date.parse(a))
  return values[0] ? new Date(values[0]).toLocaleString() : ''
}
async function load() {
  clearTimeout(debounceTimer)
  clearTimeout(refreshTimer)
  loadController?.abort()
  loadController = new AbortController()
  const signal = loadController.signal
  const current = ++loadGeneration
  loading.value = true; error.value = ''
  try {
    const [result, groupList, poolStats] = await Promise.all([
      props.workspaceId ? getIntegrationAccount(props.workspaceId, signal).then(item => ({ items: [item], total: 1, pages: 1 })) : listIntegrationAccounts({ page: page.value, page_size: pageSize.value, search: filters.search.trim() || undefined, status: filters.status || undefined, mode: filters.mode || undefined, group_id: filters.group_id || undefined }, signal),
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
  } finally {
    if (!disposed && current === loadGeneration) {
      loading.value = false
      if (accounts.value.some(account => account.status === 'provisioning')) refreshTimer = setTimeout(() => { void load() }, 3000)
    }
  }
}
watch(() => [filters.search, filters.status, filters.mode, filters.group_id], (next, previous) => {
  page.value = 1
  clearTimeout(debounceTimer)
  // Invalidate in-flight responses immediately, including during the search debounce.
  ++loadGeneration; loadController?.abort()
  debounceTimer = setTimeout(() => { void load() }, next[0] !== previous[0] ? 300 : 0)
})
watch([page, pageSize], () => { void load() })
watch(() => [props.surface, props.workspaceId], () => { page.value = 1; void load() })
function changePageSize(value: number) { pageSize.value = Math.min(200, value); page.value = 1 }
function openImport() { editingAccount.value = null; showAccountDialog.value = true }
function openEdit(account: IntegrationAccount) { editingAccount.value = account; showAccountDialog.value = true }
function closeAccountDialog(interrupted: boolean) { showAccountDialog.value = false; editingAccount.value = null; if (interrupted) feedback.value = t('admin.accountPool.requestUnknown'); void load() }
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
    else feedback.value = t('status' in result && result.status === 'provisioning' ? 'admin.accountPool.actionQueued' : 'admin.accountPool.done')
  } catch (cause) {
    if (disposed || signal.aborted) return
    feedback.value = integrationErrorMessage(cause, t('admin.accountPool.operationError'))
  } finally {
    if (!disposed) { runningAction.value = null; await load() }
  }
}
onMounted(load)
onBeforeUnmount(() => { disposed = true; ++loadGeneration; clearTimeout(debounceTimer); clearTimeout(refreshTimer); loadController?.abort(); actionController?.abort() })
</script>

<template>
  <AppLayout>
    <TablePageLayout>
      <template #actions>
        <div class="console-heading flex flex-wrap items-start justify-between gap-3">
          <div>
            <RouterLink v-if="workspaceId" to="/admin/account-pool" class="mb-2 block text-sm text-primary-700 dark:text-primary-300">← {{ t('admin.accountPool.title') }}</RouterLink>
            <h1 class="text-balance text-2xl font-semibold text-gray-900 dark:text-white">{{ heading }}</h1>
            <p class="mt-1 text-pretty text-sm text-gray-500">{{ t(surface === 'accounts' ? 'admin.accountPool.accountsDescription' : 'admin.accountPool.description') }}</p>
          </div>
          <div class="flex flex-wrap gap-2">
            <button type="button" class="btn btn-secondary" :disabled="loading" @click="load">{{ t('admin.accountPool.refresh') }}</button>
            <button type="button" class="btn btn-secondary" @click="showExits = true">{{ t('admin.accountPool.ipResources') }}</button>
            <RouterLink v-if="surface === 'accounts'" to="/admin/provider-accounts" class="btn btn-secondary">{{ t('admin.accountPool.providerAccounts') }}</RouterLink>
            <RouterLink v-if="isPoolList" to="/admin/accounts" class="btn btn-primary">{{ t('admin.accountPool.manageAccounts') }}</RouterLink>
            <button v-if="surface === 'accounts'" type="button" class="btn btn-primary" :disabled="loading || !!error || !!runningAction" @click="openImport">{{ t('admin.accountPool.import') }}</button>
          </div>
        </div>
        <p v-if="error" role="alert" class="mt-3 rounded-xl bg-red-50 p-3 text-sm text-red-700 dark:bg-red-900/20 dark:text-red-300">{{ error }}</p>
        <p v-if="feedback" role="status" class="mt-3 text-sm text-gray-600 dark:text-gray-300">{{ feedback }}</p>
        <dl v-if="!workspaceId" class="pool-stat-strip">
          <div v-for="key in statKeys" :key="key" class="pool-stat">
            <dt class="text-xs text-gray-500 dark:text-dark-300">{{ t(`admin.accountPool.${key}`) }}</dt>
            <dd class="mt-1">{{ stats?.[key] ?? '—' }}</dd>
          </div>
        </dl>
        <p class="isolation-note">{{ t('admin.accountPool.isolationSummary') }}</p>
      </template>
      <template #filters>
        <div v-if="!workspaceId" class="grid gap-3 sm:grid-cols-2">
          <input v-model="filters.search" class="input" type="search" maxlength="120" :placeholder="t('admin.accountPool.search')" :aria-label="t('admin.accountPool.search')" />
          <select v-model="filters.status" class="input" :aria-label="t('admin.accountPool.status')">
            <option value="">{{ t('admin.accountPool.allStatuses') }}</option>
            <option v-for="status in statuses" :key="status" :value="status">{{ t(`admin.accountPool.${status}`) }}</option>
          </select>
        </div>
      </template>
      <template #table>
        <section v-if="workspaceId && accounts[0]" class="mb-4 rounded-xl border p-4" :class="refreshPending(accounts[0]) ? 'border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-700 dark:bg-amber-950/20 dark:text-amber-100' : 'border-gray-200 dark:border-dark-600'" :aria-label="t('admin.accountPool.credentialState')">
          <h2 class="text-sm font-semibold">{{ t(refreshPending(accounts[0]) ? 'admin.accountPool.refreshPending' : 'admin.accountPool.credentialState') }}</h2>
          <p v-if="refreshPending(accounts[0])" class="mt-2 max-w-3xl text-pretty text-sm">{{ t('admin.accountPool.refreshPendingHint') }}</p>
          <p class="mt-2 text-xs text-gray-600 dark:text-gray-300">{{ t('admin.accountPool.stateSnapshot', { time: stateCheckedAt(accounts[0]) }) }}</p>
          <div class="mt-3 flex flex-wrap gap-2">
            <button type="button" class="btn btn-secondary btn-sm" :disabled="!!runningAction || loading || !canRun(accounts[0], 'sync')" @click="confirmation = { account: accounts[0], action: 'sync' }">{{ t('admin.accountPool.sync') }}</button>
            <button v-if="refreshPending(accounts[0])" type="button" class="btn btn-primary btn-sm" :disabled="!!runningAction || loading || !canRun(accounts[0], 'recover-credential')" @click="confirmation = { account: accounts[0], action: 'recover-credential' }">{{ t('admin.accountPool.recover-credential') }}</button>
          </div>
          <p v-if="refreshPending(accounts[0]) && (accounts[0].dispatch.inflight_requests > 0 || accounts[0].binding.credential_handoff)" class="mt-2 text-xs">{{ t('admin.accountPool.credentialRecoveryBlocked') }}</p>
        </section>
        <nav v-if="workspaceId" :aria-label="t('admin.accountPool.workspace')" class="mb-5 flex flex-wrap gap-2 border-b border-gray-200 pb-3 dark:border-dark-600">
          <button v-for="section in (['instance', 'ip', 'settings'] as const)" :key="section" type="button" class="btn" :class="workspaceSection === section ? 'btn-primary' : 'btn-secondary'" :aria-pressed="workspaceSection === section" @click="workspaceSection = section">{{ t(`admin.accountPool.section_${section}`) }}</button>
        </nav>
        <section v-if="workspaceId && workspaceSection !== 'instance' && accounts[0]" class="min-h-0 space-y-5 overflow-y-auto p-6">
          <h2 class="text-balance text-lg font-semibold">{{ t(`admin.accountPool.section_${workspaceSection}`) }}</h2>
          <template v-if="workspaceSection === 'ip'">
            <dl class="grid gap-5 sm:grid-cols-2">
              <div><dt class="text-sm text-gray-500">{{ t('admin.accountPool.fixed') }}</dt><dd class="mt-1 break-all font-mono">{{ accounts[0].slot?.egress?.proxy_id || accounts[0].binding.proxy_id || t('admin.accountPool.waitingIp') }}</dd></div>
              <div><dt class="text-sm text-gray-500">{{ t('admin.accountPool.slotTimezone') }}</dt><dd class="mt-1">{{ accounts[0].slot?.egress?.timezone || accounts[0].binding.timezone || '—' }}</dd></div>
            </dl>
            <p class="text-pretty text-sm text-gray-500">{{ t('admin.accountPool.proxyLockedHint') }}</p>
            <button type="button" class="btn btn-secondary" @click="showExits = true">{{ t('admin.accountPool.ipResources') }}</button>
          </template>
          <template v-else>
            <dl class="grid gap-5 sm:grid-cols-2">
              <div><dt class="text-sm text-gray-500">{{ t('admin.accountPool.concurrency') }}</dt><dd class="mt-1 tabular-nums">{{ accounts[0].concurrency }}</dd></div>
              <div><dt class="text-sm text-gray-500">{{ t('admin.accountPool.priority') }}</dt><dd class="mt-1 tabular-nums">{{ accounts[0].priority }}</dd></div>
              <div><dt class="text-sm text-gray-500">{{ t('admin.accountPool.slotGeneration') }}</dt><dd class="mt-1 tabular-nums">{{ accounts[0].provision_generation }}</dd></div>
            </dl>
            <button type="button" class="btn btn-primary" :disabled="lifecycleLocked(accounts[0]) || refreshPending(accounts[0])" @click="openEdit(accounts[0])">{{ t('admin.accountPool.edit') }}</button>
            <AccountPoolPublishPanel :key="workspaceId" :groups="groups.filter(group => group.lease_account_id === workspaceId || (accounts[0]?.group_ids.includes(group.id) && group.account_count === 1))" />
          </template>
        </section>
        <section v-if="isPoolList" :aria-busy="loading" class="min-h-0 space-y-4 overflow-y-auto p-5">
          <p v-if="loading" role="status" class="py-6 text-sm text-gray-500">{{ t('admin.accountPool.loading') }}</p>
          <div v-else-if="!accounts.length && !error" class="py-12 text-center"><p>{{ t('admin.accountPool.empty') }}</p><RouterLink to="/admin/accounts" class="btn btn-primary mt-4">{{ t('admin.accountPool.import') }}</RouterLink></div>
          <div class="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            <article v-for="account in accounts" :key="account.id" class="rounded-xl border border-gray-200 bg-white p-5 dark:border-dark-600 dark:bg-dark-800">
              <h2 class="text-balance break-words text-lg font-semibold">{{ account.name }}</h2>
              <p class="mt-1 break-all font-mono text-xs text-gray-500">{{ account.id }}</p>
              <p class="mt-3 text-sm" :class="account.status === 'error' ? 'text-red-600' : 'text-primary-700 dark:text-primary-300'">{{ t(`admin.accountPool.${account.status}`) }}</p>
              <p v-if="refreshPending(account)" class="mt-2 text-sm font-medium text-amber-800 dark:text-amber-200">{{ t('admin.accountPool.refreshPending') }}</p>
              <dl class="my-4 space-y-2 text-sm">
                <div><dt class="text-xs text-gray-500">{{ t('admin.accountPool.slotOwner') }}</dt><dd class="break-all">{{ account.name }}</dd></div>
                <div><dt class="text-xs text-gray-500">{{ t('admin.accountPool.fixed') }}</dt><dd class="break-all font-mono">{{ account.slot?.egress?.proxy_id || account.binding.proxy_id || t('admin.accountPool.waitingIp') }}</dd></div>
                <div><dt class="text-xs text-gray-500">{{ t('admin.accountPool.slotTimezone') }}</dt><dd>{{ account.slot?.egress?.timezone || account.binding.timezone || '—' }}</dd></div>
              </dl>
              <p v-if="account.error" class="mb-3 text-pretty text-xs text-red-600">{{ account.error.message }}</p>
              <RouterLink :to="`/admin/account-pool/${encodeURIComponent(account.id)}`" class="btn btn-secondary w-full">{{ t('admin.accountPool.openWorkspace') }}</RouterLink>
            </article>
          </div>
        </section>
        <div v-else-if="!workspaceId || workspaceSection === 'instance'" class="table-wrapper" tabindex="0" :aria-label="heading" :aria-busy="loading">
          <table>
            <thead><tr>
              <th v-for="column in columns" :key="column" scope="col">{{ t(`admin.accountPool.${column}`) }}</th>
            </tr></thead>
            <tbody>
              <tr v-if="loading && accounts.length === 0"><td :colspan="columns.length" class="text-center">{{ t('admin.accountPool.loading') }}</td></tr>
              <tr v-else-if="error"><td :colspan="columns.length" class="text-center">{{ t('admin.accountPool.loadError') }}</td></tr>
              <tr v-else-if="accounts.length === 0"><td :colspan="columns.length" class="py-12 text-center"><p class="text-pretty text-gray-600 dark:text-dark-300">{{ t('admin.accountPool.empty') }}</p><button type="button" class="btn btn-primary mt-4" @click="openImport">{{ t('admin.accountPool.import') }}</button></td></tr>
              <tr v-for="account in accounts" :key="account.id" :data-account-id="account.id">
                <td class="max-w-64">
                  <p class="break-words font-medium">{{ account.name }}</p>
                  <p class="mt-1 break-all font-mono text-xs text-gray-500">{{ account.id }}</p>
                  <p class="mt-2 text-xs">{{ t('admin.accountPool.oneAccountOnePool') }}</p>
                  <div v-if="workspaceId" class="mt-1 flex flex-wrap gap-1">
                    <span v-for="id in account.group_ids" :key="id" class="rounded bg-gray-100 px-1.5 py-0.5 text-xs dark:bg-dark-700">{{ groupNames.get(id) || id }}</span>
                    <span v-if="!account.group_ids.length" class="text-xs text-amber-600">{{ t('admin.accountPool.unassigned') }}</span>
                  </div>
                </td>
                <td class="max-w-72">
                  <span :class="account.status === 'ready' ? 'text-emerald-700 dark:text-emerald-300' : account.status === 'error' ? 'text-red-700 dark:text-red-300' : 'text-gray-500'">{{ t(`admin.accountPool.${account.status}`) }}</span>
                  <p class="mt-1 text-xs">{{ t(account.schedulable ? 'admin.accountPool.schedulable' : 'admin.accountPool.paused') }}</p>
                  <p v-if="account.slot_binding_stale" class="mt-1 text-xs text-amber-700 dark:text-amber-300">{{ t('admin.accountPool.stale') }}</p>
                  <p v-if="account.deletion_pending" class="mt-1 text-xs text-red-600">{{ t('admin.accountPool.deletionPending') }}</p>
                  <p v-if="refreshPending(account)" class="mt-1 text-xs font-medium text-amber-800 dark:text-amber-200">{{ t('admin.accountPool.refreshPending') }}</p>
                  <p v-if="account.slot?.health?.ok === false" class="mt-1 text-xs text-red-600">{{ t('admin.accountPool.healthFailed') }}</p>
                  <p v-else-if="account.slot && account.slot.health?.ok == null" class="mt-1 text-xs text-gray-500">{{ t('admin.accountPool.healthUnknown') }}</p>
                  <p v-if="account.error" class="mt-1 break-words text-xs text-red-600 dark:text-red-300">{{ account.error.message }} <span class="font-mono">({{ account.error.code }})</span></p>
                  <p v-if="cooldownUntil(account)" class="mt-1 text-xs text-amber-700 dark:text-amber-300">{{ t('admin.accountPool.cooldown', { time: cooldownUntil(account) }) }}</p>
                </td>
                <td v-if="surface !== 'accounts'">
                  <p class="tabular-nums">{{ t('admin.accountPool.inflight', { used: account.dispatch.inflight_requests, limit: account.concurrency }) }}</p>
                  <p class="mt-1 text-xs text-gray-500">{{ t('admin.accountPool.priorityValue', { value: account.priority }) }}</p>
                </td>
                <td v-if="surface !== 'accounts'" class="max-w-60">
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
                      <div><dt>{{ t('admin.accountPool.executionBackend') }}</dt><dd>{{ t(account.binding.execution_backend === 'codex-cli' ? 'admin.accountPool.cliBackend' : 'admin.accountPool.kernelBackend') }}</dd></div>
                    </dl>
                  </details>
                </td>
                <td>
                  <div class="flex max-w-72 flex-wrap gap-2">
                    <RouterLink v-if="!workspaceId" :to="`/admin/account-pool/${encodeURIComponent(account.id)}`" class="btn btn-primary btn-sm">{{ t('admin.accountPool.openWorkspace') }}</RouterLink>
                    <button type="button" class="btn btn-secondary btn-sm" :disabled="!!runningAction || loading || lifecycleLocked(account) || refreshPending(account)" @click="openEdit(account)">{{ t('admin.accountPool.edit') }}</button>
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
        <Pagination v-if="total > 0 && !workspaceId" :total="total" :page="page" :page-size="pageSize" :page-size-options="[20, 50, 100, 200]" @update:page="page = $event" @update:page-size="changePageSize" />
      </template>
    </TablePageLayout>
    <AccountPoolAccountDialog v-if="showAccountDialog" :show="showAccountDialog" :account="editingAccount" :groups="groups" @close="closeAccountDialog" @saved="onSaved" />
    <ExitResourcesDialog v-if="showExits" :show="showExits" @close="showExits = false" @changed="load" />
    <ConfirmDialog :show="!!confirmation" :title="t('admin.accountPool.confirmTitle')" :message="confirmation ? t('admin.accountPool.confirmAction', { name: confirmation.account.name, action: t(`admin.accountPool.${confirmation.action}`) }) : ''" :danger="!!confirmation && ['delete', 'retry-delete', 'stop', 'recover'].includes(confirmation.action)" :confirm-text="t('admin.accountPool.confirm')" @cancel="confirmation = null" @confirm="performAction">
      <p class="text-sm text-gray-600 dark:text-gray-400">{{ confirmation ? t(`admin.accountPool.${confirmMessages[confirmation.action]}`) : '' }}</p>
    </ConfirmDialog>
  </AppLayout>
</template>
