<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import BaseDialog from '@/components/common/BaseDialog.vue'
import { exchangeCode, generateAuthUrl } from '@/api/admin/accounts'
import { importIntegrationAccount, updateIntegrationAccount, listExitResources, type ExitResource, type IntegrationAccount, type IntegrationAccountMode, type IntegrationAccountUpdate, type IntegrationGroup } from '@/api/admin/integrationAccounts'
import { integrationErrorMessage } from '@/api/admin/integrationClient'
import { parseOAuthCredential } from './credentialInput'

const props = defineProps<{ show: boolean; account?: IntegrationAccount | null; groups: IntegrationGroup[] }>()
const emit = defineEmits<{ close: [interrupted: boolean]; saved: [account: IntegrationAccount] }>()
const { t } = useI18n()
const editing = computed(() => !!props.account)
const exits = shallowRef<ExitResource[]>([])
const exitError = shallowRef('')
const draft = reactive({ id: '', name: '', mode: 'pool' as IntegrationAccountMode, groupIds: [] as string[], concurrency: 2, priority: 50, proxyId: '', schedulable: false, backend: 'kernel' as 'kernel' | 'codex-cli' })
watch(() => draft.backend, value => { if (value === 'codex-cli') draft.concurrency = 1 })
const credentialText = shallowRef('')
const credentialMode = ref<'json' | 'oauth'>('json')
const pending = shallowRef(false)
const error = shallowRef('')
const oauthAuthUrl = shallowRef('')
const oauthSessionId = shallowRef('')
const oauthState = shallowRef('')
const oauthCode = shallowRef('')
const oauthCredential = shallowRef<Record<string, unknown> | null>(null)
const oauthLoading = shallowRef(false)
const oauthError = shallowRef('')
let controller: AbortController | undefined
let generation = 0
let oauthGeneration = 0
let importKey = ''
const eligibleGroups = computed(() => props.groups.filter(group => draft.groupIds.includes(group.id) || (
  group.status === 'active' && (draft.mode === 'pool' ? group.strategy === 'shared' : group.strategy === 'per_slot' && !group.lease_account_id)
)))
const bindingChanged = computed(() => !!props.account && draft.concurrency !== props.account.concurrency)
const canEnableScheduling = computed(() => !!props.account && props.account.status === 'ready' && props.account.slot?.ready === true && !!props.account.vm_id && !props.account.slot_binding_stale && !bindingChanged.value && !props.account.modeltrace.state.auto_paused && draft.groupIds.length > 0 && draft.groupIds.every(id => props.groups.some(group => group.id === id && group.status === 'active')))
watch(bindingChanged, changed => { if (changed) draft.schedulable = false })
function clearSensitiveState() {
  ++generation
  resetOAuth()
  controller?.abort()
  controller = undefined
  credentialText.value = ''
  credentialMode.value = 'json'
  importKey = ''
  pending.value = false
}
function resetOAuth() {
  ++oauthGeneration
  oauthAuthUrl.value = ''
  oauthSessionId.value = ''
  oauthState.value = ''
  oauthCode.value = ''
  oauthCredential.value = null
  oauthLoading.value = false
  oauthError.value = ''
}
function reset() {
  clearSensitiveState()
  const account = props.account
  Object.assign(draft, { id: account?.id || crypto.randomUUID(), name: account?.name || '', mode: account?.mode || 'pool', groupIds: [...(account?.group_ids || [])], concurrency: account?.concurrency ?? 2, priority: account?.priority ?? 50, proxyId: account?.binding.proxy_id || '', schedulable: account?.schedulable ?? false, backend: account?.binding.execution_backend || 'kernel' })
  error.value = ''
  exitError.value = ''; exits.value = []
  if (!account) {
    const current = generation
    controller = new AbortController()
    listExitResources(controller.signal).then(rows => { if (current === generation) exits.value = rows.filter(row => row.available) })
      .catch(() => { if (current === generation) exitError.value = t('admin.accountPool.ipLoadFailed') })
  }
}
watch(() => [props.show, props.account] as const, ([show]) => { if (show) reset(); else clearSensitiveState() }, { immediate: true })
function invalidateImportKey() { if (!pending.value) importKey = '' }
function switchCredentialMode(mode: 'json' | 'oauth') {
  if (editing.value || pending.value || oauthLoading.value) return
  credentialMode.value = mode
  importKey = ''
  error.value = ''
  if (mode === 'json') {
    resetOAuth()
  } else {
    credentialText.value = ''
  }
}
function close() {
  const interrupted = pending.value || oauthLoading.value
  clearSensitiveState()
  error.value = ''
  emit('close', interrupted)
}
function validateDraft() {
  if (!draft.name.trim() || !Number.isInteger(draft.concurrency) || draft.concurrency < 1 || draft.concurrency > 256 || !Number.isInteger(draft.priority) || draft.priority < 0 || draft.priority > 100000) {
    error.value = t('admin.accountPool.invalidValues'); return false
  }
  if (!/^[a-z0-9][a-z0-9_-]{0,75}$/i.test(draft.id) || draft.id.toLowerCase().endsWith('-chat')) { error.value = t('admin.accountPool.invalidAccountId'); return false }
  return true
}
function buildOAuthCredential(tokenInfo: Record<string, unknown>) {
  const credential: Record<string, unknown> = {}
  for (const key of ['access_token', 'refresh_token', 'id_token', 'expires_at', 'client_id', 'email', 'plan_type', 'subscription_expires_at', 'chatgpt_account_id', 'chatgpt_user_id', 'organization_id']) {
    const value = tokenInfo[key]
    if ((typeof value === 'string' && value.trim()) || (typeof value === 'number' && Number.isFinite(value))) credential[key] = value
  }
  try { return parseOAuthCredential(JSON.stringify(credential)) } catch { throw new Error('invalidCredential') }
}
async function importCredential(credential: Record<string, unknown>) {
  pending.value = true
  controller = new AbortController()
  const current = ++generation
  const signal = controller.signal
  try {
    importKey ||= `account-import-${crypto.randomUUID()}`
    const saved = await importIntegrationAccount({ account_id: draft.id, name: draft.name.trim(), mode: draft.mode, group_ids: [...draft.groupIds], concurrency: draft.concurrency, priority: draft.priority, proxy_id: draft.proxyId.trim() || null, execution_backend: draft.backend, credential }, importKey, signal)
    if (current !== generation || signal.aborted) return
    credentialText.value = ''
    importKey = ''
    pending.value = false
    emit('saved', saved)
    close()
  } catch (cause) {
    if (current !== generation || signal.aborted) return
    error.value = integrationErrorMessage(cause, t('admin.accountPool.importFailed'))
    if (credentialMode.value === 'oauth') oauthError.value = t('admin.accountPool.oauthImportFailed')
  } finally {
    if (current === generation) pending.value = false
  }
}
async function save() {
  if (pending.value || oauthLoading.value) return
  if (!editing.value && credentialMode.value === 'oauth') { await completeOAuth(); return }
  if (editing.value) {
    error.value = ''
    if (!validateDraft()) return
    const account = props.account!
    const data: IntegrationAccountUpdate = {}
    if (draft.name.trim() !== account.name) data.name = draft.name.trim()
    if (draft.concurrency !== account.concurrency) data.concurrency = draft.concurrency
    if (draft.priority !== account.priority) data.priority = draft.priority
    if (JSON.stringify([...draft.groupIds].sort()) !== JSON.stringify([...account.group_ids].sort())) data.group_ids = [...draft.groupIds]
    if (bindingChanged.value) data.schedulable = false
    else if (draft.schedulable !== account.schedulable) data.schedulable = draft.schedulable
    pending.value = true
    controller = new AbortController()
    const signal = controller.signal
    const current = ++generation
    try {
      const saved = await updateIntegrationAccount(account.id, data, signal)
      if (current !== generation || signal.aborted) return
      pending.value = false
      emit('saved', saved)
      close()
    } catch (cause) {
      if (current !== generation || signal.aborted) return
      error.value = integrationErrorMessage(cause, t('admin.accountPool.operationError'))
    } finally {
      if (current === generation) pending.value = false
    }
    return
  }
  if (!validateDraft()) return
  error.value = ''
  let credential: Record<string, unknown>
  try { credential = parseOAuthCredential(credentialText.value) } catch (cause) {
    error.value = t(`admin.accountPool.${(cause as Error).message}`); return
  }
  await importCredential(credential)
}
async function generateOAuthUrl() {
  if (pending.value || oauthLoading.value || !props.show || editing.value || credentialMode.value !== 'oauth') return
  resetOAuth()
  const current = oauthGeneration
  oauthLoading.value = true
  oauthError.value = ''
  try {
    const response = await generateAuthUrl('/admin/openai/generate-auth-url', {})
    if (current !== oauthGeneration) return
    const url = new URL(response.auth_url)
    const state = url.searchParams.get('state')
    if (url.protocol !== 'https:' || !state || !response.session_id) throw new Error('invalidOAuthResponse')
    oauthAuthUrl.value = response.auth_url
    oauthSessionId.value = response.session_id
    oauthState.value = state
  } catch {
    if (current === oauthGeneration) oauthError.value = t('admin.accountPool.oauthGenerateFailed')
  } finally {
    if (current === oauthGeneration) oauthLoading.value = false
  }
}
const oauthCallback = computed(() => {
  const trimmed = oauthCode.value.trim()
  if (!trimmed) return null
  if (!trimmed.includes('?') && !trimmed.includes('code=')) return { code: trimmed, state: '' }
  try {
    const parsed = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : `http://localhost/callback?${trimmed.replace(/^\?/, '')}`)
    const code = parsed.searchParams.get('code')
    const state = parsed.searchParams.get('state')
    return code ? { code, state: state || '' } : null
  } catch { return null }
})
const canExchangeOAuth = computed(() => (oauthCredential.value !== null || (!!oauthSessionId.value && !!oauthCallback.value && !!oauthState.value.trim())) && !pending.value && !oauthLoading.value)
async function completeOAuth() {
  if (!canExchangeOAuth.value || !props.show || editing.value || credentialMode.value !== 'oauth') return
  error.value = ''
  if (!validateDraft()) return
  if (oauthCallback.value?.state && oauthCallback.value.state !== oauthState.value) {
    oauthError.value = t('admin.accountPool.oauthStateMismatch'); return
  }
  const current = oauthGeneration
  oauthLoading.value = true
  oauthError.value = ''
  try {
    if (!oauthCredential.value) {
      const tokenInfo = await exchangeCode('/admin/openai/exchange-code', { session_id: oauthSessionId.value, code: oauthCallback.value!.code, state: oauthState.value.trim() })
      if (current !== oauthGeneration) return
      oauthCredential.value = buildOAuthCredential(tokenInfo)
      oauthAuthUrl.value = ''
      oauthSessionId.value = ''
      oauthState.value = ''
      oauthCode.value = ''
    }
    await importCredential(oauthCredential.value)
  } catch {
    if (current === oauthGeneration) oauthError.value = t('admin.accountPool.oauthExchangeFailed')
  } finally {
    if (current === oauthGeneration) oauthLoading.value = false
  }
}
onBeforeUnmount(clearSensitiveState)
</script>

<template>
  <BaseDialog :show="show" :title="t(editing ? 'admin.accountPool.edit' : 'admin.accountPool.import')" width="wide" @close="close">
    <form :aria-busy="pending || oauthLoading" id="account-pool-form" class="space-y-5" autocomplete="off" @submit.prevent="save" @input="invalidateImportKey">
      <p v-if="error" role="alert" class="rounded-xl bg-red-50 p-3 text-sm text-red-700 dark:bg-red-900/20 dark:text-red-300">{{ error }}</p>
      <fieldset :disabled="pending || oauthLoading" class="grid gap-4 sm:grid-cols-2">
        <label class="block text-sm">{{ t('admin.accountPool.name') }}
          <input v-model="draft.name" class="input mt-1" maxlength="160" required />
        </label>
        <label class="block text-sm">{{ t('admin.accountPool.accountId') }}
          <input v-model="draft.id" class="input mt-1 font-mono" maxlength="76" required :disabled="editing" />
          <span v-if="!editing" class="mt-1 block text-xs text-gray-500">{{ t('admin.accountPool.accountIdHint') }}</span>
        </label>
        <label v-if="editing" class="block text-sm">{{ t('admin.accountPool.mode') }}
          <select v-model="draft.mode" class="input mt-1" :disabled="editing" @change="draft.groupIds = []">
            <option value="pool">{{ t('admin.accountPool.pool') }}</option>
            <option value="lease">{{ t('admin.accountPool.lease') }}</option>
          </select>
        </label>
        <label class="block text-sm">{{ t('admin.accountPool.proxyId') }}
          <input v-if="editing" :value="draft.proxyId || account?.slot?.egress?.proxy_id" class="input mt-1" disabled />
          <select v-else v-model="draft.proxyId" class="input mt-1">
            <option value="">{{ t('admin.accountPool.autoIp') }}</option>
            <option v-for="exit in exits" :key="exit.id" :value="exit.id">{{ exit.label || `${exit.host}:${exit.port}` }}</option>
          </select>
          <span v-if="exitError" role="alert" class="mt-1 block text-xs text-red-600">{{ exitError }}</span>
          <span class="mt-1 block text-xs text-gray-500">{{ t(editing ? 'admin.accountPool.proxyLockedHint' : 'admin.accountPool.proxyHint') }}</span>
        </label>
        <label class="block text-sm">{{ t('admin.accountPool.executionBackend') }}
          <select v-model="draft.backend" class="input mt-1" :disabled="editing">
            <option value="kernel">{{ t('admin.accountPool.kernelBackend') }}</option>
            <option value="codex-cli">{{ t('admin.accountPool.cliBackend') }}</option>
          </select>
          <span class="mt-1 block text-xs text-gray-500">{{ t('admin.accountPool.cliBackendHint') }}</span>
        </label>
        <label class="block text-sm">{{ t('admin.accountPool.concurrency') }}
          <input v-model.number="draft.concurrency" type="number" class="input mt-1" min="1" :max="draft.backend === 'codex-cli' ? 1 : 256" :disabled="draft.backend === 'codex-cli'" step="1" required />
        </label>
        <label class="block text-sm">{{ t('admin.accountPool.priority') }}
          <input v-model.number="draft.priority" type="number" class="input mt-1" min="0" max="100000" step="1" required />
          <span class="mt-1 block text-xs text-gray-500">{{ t('admin.accountPool.priorityHint') }}</span>
        </label>
      </fieldset>
      <fieldset v-if="editing" :disabled="true" class="space-y-2">
        <legend class="mb-2 text-sm font-medium">{{ t('admin.accountPool.groupBinding') }}</legend>
        <p class="text-xs text-gray-500">{{ t(editing && draft.mode === 'lease' ? 'admin.accountPool.leaseLocked' : draft.mode === 'lease' ? 'admin.accountPool.leaseGroupHint' : 'admin.accountPool.poolGroupHint') }}</p>
        <label v-if="draft.mode === 'lease' && !editing" class="flex items-center gap-2 text-sm">
          <input type="radio" name="lease-group" :checked="draft.groupIds.length === 0" @change="draft.groupIds = []" />{{ t('admin.accountPool.autoLeaseGroup') }}
        </label>
        <div class="flex max-h-40 flex-wrap gap-3 overflow-y-auto">
          <label v-for="group in eligibleGroups" :key="group.id" class="flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-sm dark:border-dark-600">
            <input v-if="draft.mode === 'pool'" v-model="draft.groupIds" type="checkbox" :value="group.id" :disabled="group.status !== 'active' && !draft.groupIds.includes(group.id)" />
            <input v-else type="radio" name="lease-group" :checked="draft.groupIds.includes(group.id)" :disabled="group.status !== 'active'" @change="draft.groupIds = [group.id]" />
            {{ group.name }}<span v-if="group.status !== 'active'" class="text-xs text-amber-600">{{ t('admin.accountPool.inactive') }}</span>
          </label>
        </div>
        <p v-if="eligibleGroups.length === 0 && draft.mode === 'pool'" class="text-sm text-gray-500">{{ t('admin.accountPool.noGroups') }}</p>
      </fieldset>
      <template v-if="editing">
        <p v-if="bindingChanged" class="rounded-xl bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-900/20 dark:text-amber-300">{{ t('admin.accountPool.rebindWarning') }}</p>
        <label class="flex items-center gap-2 text-sm">
          <input v-model="draft.schedulable" type="checkbox" :disabled="pending || (!draft.schedulable && !canEnableScheduling)" />{{ t('admin.accountPool.enableScheduling') }}
        </label>
        <p class="text-xs text-gray-500">{{ t('admin.accountPool.schedulingHint') }}</p>
      </template>
      <template v-else>
        <div class="space-y-3">
          <div class="flex flex-wrap gap-2" role="group" :aria-label="t('admin.accountPool.oauthSource')">
            <button type="button" data-testid="oauth-mode-json" class="btn btn-secondary text-sm" :aria-pressed="credentialMode === 'json'" :class="credentialMode === 'json' ? 'ring-2 ring-primary-500' : ''" :disabled="pending || oauthLoading" @click="switchCredentialMode('json')">{{ t('admin.accountPool.oauthModeJson') }}</button>
            <button type="button" data-testid="oauth-mode-browser" class="btn btn-secondary text-sm" :aria-pressed="credentialMode === 'oauth'" :class="credentialMode === 'oauth' ? 'ring-2 ring-primary-500' : ''" :disabled="pending || oauthLoading" @click="switchCredentialMode('oauth')">{{ t('admin.accountPool.oauthModeBrowser') }}</button>
          </div>
          <p class="text-xs text-gray-500">{{ t('admin.accountPool.oauthSourceHint') }}</p>
        </div>
        <label v-if="credentialMode === 'json'" class="block text-sm">{{ t('admin.accountPool.oauth') }}
          <textarea v-model="credentialText" data-testid="oauth-input" class="input mt-1 min-h-40 font-mono text-xs" rows="6" spellcheck="false" autocomplete="off" autocapitalize="off" :disabled="pending" required />
          <span class="mt-2 block text-xs text-gray-500">{{ t('admin.accountPool.oauthHint') }}</span>
        </label>
        <div v-else class="space-y-3">
          <p v-if="oauthError" role="alert" class="rounded-xl bg-red-50 p-3 text-sm text-red-700 dark:bg-red-900/20 dark:text-red-300">{{ oauthError }}</p>
          <p class="text-xs text-gray-500">{{ t('admin.accountPool.oauthBrowserHint') }}</p>
          <div class="rounded-xl border border-blue-200 bg-blue-50/70 p-4 dark:border-blue-800 dark:bg-blue-900/20">
            <p class="text-sm font-medium text-blue-900 dark:text-blue-200">{{ t('admin.accountPool.oauthStep1') }}</p>
            <button type="button" data-testid="oauth-generate" class="btn btn-primary mt-3" :disabled="oauthLoading || pending || !!oauthCredential" @click="generateOAuthUrl">{{ t(oauthLoading ? 'admin.accountPool.working' : 'admin.accountPool.oauthGenerate') }}</button>
            <p v-if="oauthCredential" role="status" class="mt-3 text-sm">{{ t('admin.accountPool.oauthAuthorized') }}</p>
            <div v-if="oauthAuthUrl" class="mt-3 space-y-2">
              <a :href="oauthAuthUrl" target="_blank" rel="noreferrer" class="block break-all text-xs text-blue-700 underline dark:text-blue-300">{{ oauthAuthUrl }}</a>
              <p class="text-xs text-blue-800 dark:text-blue-200">{{ t('admin.accountPool.oauthStep2') }}</p>
            </div>
            <label class="mt-4 block text-sm font-medium text-blue-900 dark:text-blue-200">{{ t('admin.accountPool.oauthStep3') }}
              <textarea v-model="oauthCode" data-testid="oauth-code-input" class="input mt-1 min-h-24 font-mono text-xs" rows="4" spellcheck="false" autocomplete="off" autocapitalize="off" :disabled="oauthLoading || pending || !!oauthCredential" />
            </label>
          </div>
        </div>
      </template>
    </form>
    <template #footer>
      <div class="flex justify-end gap-3">
        <button type="button" data-testid="account-pool-close" class="btn btn-secondary" @click="close">{{ t('admin.accountPool.close') }}</button>
        <button v-if="!(!editing && credentialMode === 'oauth')" type="submit" form="account-pool-form" class="btn btn-primary" :disabled="pending">{{ t(pending ? 'admin.accountPool.working' : editing ? 'admin.accountPool.save' : 'admin.accountPool.import') }}</button>
        <button v-else type="button" data-testid="oauth-complete" class="btn btn-primary" :disabled="!canExchangeOAuth" @click="completeOAuth">{{ t(oauthLoading || pending ? 'admin.accountPool.working' : 'admin.accountPool.oauthComplete') }}</button>
      </div>
    </template>
  </BaseDialog>
</template>
