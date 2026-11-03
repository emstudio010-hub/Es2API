<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import BaseDialog from '@/components/common/BaseDialog.vue'
import { listExitResources, importExitResources, type ExitResource } from '@/api/admin/integrationAccounts'
import { integrationErrorMessage } from '@/api/admin/integrationClient'
defineProps<{ show: boolean }>()
const emit = defineEmits<{ close: []; changed: [] }>()
const { t } = useI18n()
const rows = ref<ExitResource[]>([]), text = ref(''), error = ref(''), feedback = ref(''), pending = ref(false)
const controller = new AbortController()
let disposed = false
async function load() {
  try { const result = await listExitResources(controller.signal); if (!disposed) rows.value = result }
  catch (cause) { if (!disposed) error.value = integrationErrorMessage(cause, t('admin.accountPool.loadError')) }
}
async function save() {
  if (pending.value || !text.value.trim()) return
  pending.value = true; error.value = ''; feedback.value = ''
  try {
    const result = await importExitResources(text.value, controller.signal)
    if (disposed) return
    text.value = ''; feedback.value = t('admin.accountPool.ipImported', result); emit('changed'); await load()
  } catch { if (!disposed) error.value = t('admin.accountPool.ipImportFailed') }
  finally { if (!disposed) pending.value = false }
}
function close() { text.value = ''; emit('close') }
onMounted(load)
onBeforeUnmount(() => { disposed = true; text.value = ''; controller.abort() })
</script>
<template>
  <BaseDialog :show="show" :title="t('admin.accountPool.ipResources')" width="wide" @close="close">
    <div class="space-y-4">
      <p class="text-pretty text-sm text-gray-500">{{ t('admin.accountPool.ipResourcesHint') }}</p>
      <p v-if="error" role="alert" class="text-sm text-red-600">{{ error }}</p>
      <p v-if="feedback" role="status" class="text-sm text-primary-700 dark:text-primary-300">{{ feedback }}</p>
      <form class="space-y-3" autocomplete="off" @submit.prevent="save">
        <label class="block text-sm">{{ t('admin.accountPool.ipImport') }}
          <textarea v-model="text" class="input mt-2 min-h-24 font-mono text-xs" rows="4" maxlength="1048576" spellcheck="false" autocapitalize="off" :disabled="pending" placeholder="socks5://username:password@host:port" />
        </label>
        <button type="submit" class="btn btn-primary" :disabled="pending || !text.trim()">{{ t(pending ? 'admin.accountPool.working' : 'admin.accountPool.ipImport') }}</button>
      </form>
      <div class="max-h-80 overflow-auto">
        <ul class="divide-y divide-gray-200 dark:divide-dark-600">
          <li v-for="row in rows" :key="row.id" class="flex flex-wrap justify-between gap-2 py-3 text-sm">
            <div><p class="font-mono">{{ row.host }}:{{ row.port }}</p><p class="text-xs text-gray-500">{{ row.id }} · {{ row.timezone || t('admin.accountPool.isolationPending') }}</p></div>
            <span>{{ t(row.available ? 'admin.accountPool.ipFree' : row.bound_vm_ids.length ? 'admin.accountPool.ipUsed' : 'admin.accountPool.ipUnavailable') }}</span>
          </li>
        </ul>
        <p v-if="!rows.length" class="py-6 text-sm text-gray-500">{{ t('admin.accountPool.noIpResources') }}</p>
      </div>
    </div>
    <template #footer><button type="button" class="btn btn-secondary" @click="close">{{ t('admin.accountPool.close') }}</button></template>
  </BaseDialog>
</template>
