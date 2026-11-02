<script setup lang="ts">
import { onBeforeUnmount, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import BaseDialog from '@/components/common/BaseDialog.vue'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'
import AccountPoolPublishPanel from './AccountPoolPublishPanel.vue'
import { createIntegrationGroup, updateIntegrationGroup, type IntegrationGroup } from '@/api/admin/integrationAccounts'
import { integrationErrorMessage } from '@/api/admin/integrationClient'
const props = defineProps<{ show: boolean; groups: IntegrationGroup[] }>()
const emit = defineEmits<{ close: [interrupted: boolean]; changed: [] }>()
const { t } = useI18n()
const name = shallowRef('')
const strategy = shallowRef<'shared' | 'per_slot'>('shared')
const currentGroups = shallowRef<IntegrationGroup[]>([])
const confirmation = shallowRef<IntegrationGroup | null>(null)
const pending = shallowRef(false)
const error = shallowRef('')
const feedback = shallowRef('')
let controller: AbortController | undefined
let generation = 0
watch(() => props.groups, groups => { currentGroups.value = groups }, { immediate: true })
function cleanup() { ++generation; controller?.abort(); controller = undefined; pending.value = false; confirmation.value = null }
watch(() => props.show, show => {
  cleanup()
  if (show) { name.value = ''; strategy.value = 'shared'; error.value = ''; feedback.value = '' }
})
function close() { const interrupted = pending.value; cleanup(); emit('close', interrupted) }
async function mutate(operation: (signal: AbortSignal) => Promise<IntegrationGroup>, success: string) {
  if (pending.value) return
  pending.value = true; error.value = ''; feedback.value = ''
  controller = new AbortController()
  const signal = controller.signal
  const current = ++generation
  try {
    const group = await operation(signal)
    if (current !== generation || signal.aborted) return
    currentGroups.value = [...currentGroups.value.filter(item => item.id !== group.id), group].sort((a, b) => a.name.localeCompare(b.name))
    feedback.value = t(success)
    if (success === 'admin.accountPool.groupCreated') name.value = ''
    emit('changed')
  } catch (cause) {
    if (current === generation && !signal.aborted) error.value = integrationErrorMessage(cause, t('admin.accountPool.operationError'))
  } finally { if (current === generation) pending.value = false }
}
async function create() {
  if (!name.value.trim() || name.value.trim().length > 100) { error.value = t('admin.accountPool.groupNameRequired'); return }
  const input = { name: name.value.trim(), strategy: strategy.value }
  await mutate(signal => createIntegrationGroup(input, signal), 'admin.accountPool.groupCreated')
}
async function toggleStatus() {
  const group = confirmation.value
  if (!group || pending.value) return
  confirmation.value = null
  await mutate(signal => updateIntegrationGroup(group.id, { status: group.status === 'active' ? 'inactive' : 'active' }, signal), 'admin.accountPool.groupUpdated')
}
onBeforeUnmount(cleanup)
</script>

<template>
  <BaseDialog :show="show" :title="t('admin.accountPool.groups')" width="wide" @close="close">
    <div class="space-y-5">
      <p v-if="error" role="alert" class="rounded-xl bg-red-50 p-3 text-sm text-red-700 dark:bg-red-900/20 dark:text-red-300">{{ error }}</p>
      <p v-if="feedback" role="status" class="text-sm text-emerald-700 dark:text-emerald-300">{{ feedback }}</p>
      <form class="flex flex-wrap items-end gap-3" @submit.prevent="create">
        <label class="min-w-40 flex-1 text-sm">{{ t('admin.accountPool.groupName') }}
          <input v-model="name" class="input mt-1" maxlength="100" required :disabled="pending" />
        </label>
        <label class="text-sm">{{ t('admin.accountPool.strategy') }}
          <select v-model="strategy" class="input mt-1" :disabled="pending">
            <option value="shared">{{ t('admin.accountPool.shared') }}</option>
            <option value="per_slot">{{ t('admin.accountPool.per_slot') }}</option>
          </select>
        </label>
        <button type="submit" class="btn btn-primary" :disabled="pending">{{ t(pending ? 'admin.accountPool.working' : 'admin.accountPool.createGroup') }}</button>
      </form>
      <ul class="max-h-96 divide-y divide-gray-100 overflow-y-auto dark:divide-dark-700">
        <li v-for="group in currentGroups" :key="group.id" class="flex flex-wrap items-center justify-between gap-3 py-3">
          <div class="min-w-0">
            <p class="break-words font-medium">{{ group.name }}</p>
            <p class="break-all font-mono text-xs text-gray-500">{{ group.id }}</p>
            <p class="mt-1 text-xs text-gray-500">{{ t(`admin.accountPool.${group.strategy}`) }} · {{ t(`admin.accountPool.${group.status}`) }} · {{ t('admin.accountPool.groupCount', { count: group.account_count }) }}</p>
          </div>
          <button type="button" class="btn btn-secondary btn-sm" :disabled="pending" @click="confirmation = group">{{ t(group.status === 'active' ? 'admin.accountPool.disableGroup' : 'admin.accountPool.enableGroup') }}</button>
        </li>
      </ul>
      <p v-if="!currentGroups.length" class="py-4 text-center text-sm text-gray-500">{{ t('admin.accountPool.noGroupRecords') }}</p>
      <AccountPoolPublishPanel v-if="show" :groups="currentGroups" />
    </div>
    <template #footer><button type="button" class="btn btn-secondary" @click="close">{{ t('admin.accountPool.close') }}</button></template>
  </BaseDialog>
  <ConfirmDialog :show="!!confirmation" :title="t('admin.accountPool.confirmGroupTitle')" :message="confirmation ? t(confirmation.status === 'active' ? 'admin.accountPool.confirmGroupDisable' : 'admin.accountPool.confirmGroupEnable', { name: confirmation.name }) : ''" :danger="confirmation?.status === 'active'" @cancel="confirmation = null" @confirm="toggleStatus" />
</template>
