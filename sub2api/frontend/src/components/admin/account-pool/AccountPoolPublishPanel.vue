<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { getAll } from '@/api/admin/groups'
import { integrationRequest, integrationErrorMessage } from '@/api/admin/integrationClient'
import type { IntegrationGroup } from '@/api/admin/integrationAccounts'
import type { AdminGroup } from '@/types'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'

defineProps<{ groups: IntegrationGroup[] }>()
const { t } = useI18n()
type Publication = { group_id: string; native_account_id: number; native_group_ids: number[]; published: boolean }
const nativeGroups = ref<AdminGroup[]>([]), publications = ref<Publication[]>([])
const groupId = ref(''), nativeGroupId = ref<number | ''>(''), concurrency = ref(10)
const loading = ref(true), pending = ref(false), error = ref(''), feedback = ref('')
const revoke = ref<Publication | null>(null)
const controller = new AbortController()
let disposed = false
async function load() {
  const [groups, links] = await Promise.all([getAll('openai'), integrationRequest<Publication[]>('/publications', { signal: controller.signal })])
  if (disposed) return
  nativeGroups.value = groups; publications.value = links
}
async function publish() {
  if (pending.value || !groupId.value || !nativeGroupId.value) return
  pending.value = true; error.value = ''; feedback.value = ''
  try {
    await integrationRequest(`/groups/${encodeURIComponent(groupId.value)}/publish`, { method: 'POST', signal: controller.signal,
      data: { native_group_id: nativeGroupId.value, concurrency: concurrency.value } })
    if (disposed) return
    feedback.value = t('admin.accountPool.publishSaved'); await load()
  } catch (cause) { if (!disposed) error.value = integrationErrorMessage(cause, t('admin.accountPool.operationError')) }
  finally { if (!disposed) pending.value = false }
}
async function unpublish() {
  const target = revoke.value; revoke.value = null
  if (!target || pending.value) return
  pending.value = true; error.value = ''; feedback.value = ''
  try {
    await integrationRequest(`/groups/${encodeURIComponent(target.group_id)}/publish`, { method: 'DELETE', signal: controller.signal })
    if (!disposed) { feedback.value = t('admin.accountPool.publishRemoved'); await load() }
  } catch (cause) { if (!disposed) error.value = integrationErrorMessage(cause, t('admin.accountPool.operationError')) }
  finally { if (!disposed) pending.value = false }
}
onMounted(async () => {
  try { await load() } catch (cause) { if (!disposed) error.value = integrationErrorMessage(cause, t('admin.accountPool.operationError')) }
  finally { if (!disposed) loading.value = false }
})
onBeforeUnmount(() => { disposed = true; controller.abort() })
</script>

<template>
  <section class="space-y-4 rounded-xl border border-gray-200 p-4 dark:border-dark-700" :aria-busy="loading || pending" aria-labelledby="pool-publish-title">
    <div>
      <h3 id="pool-publish-title" class="text-balance font-semibold">{{ t('admin.accountPool.publishTitle') }}</h3>
      <p id="pool-publish-help" class="mt-1 text-pretty text-sm text-gray-600 dark:text-dark-300">{{ t('admin.accountPool.publishHint') }}</p>
    </div>
    <p v-if="error" id="pool-publish-error" role="alert" class="text-sm text-red-700 dark:text-red-300">{{ error }}</p>
    <p v-if="feedback" role="status" class="text-sm text-emerald-700 dark:text-emerald-300">{{ feedback }}</p>
    <p v-if="loading" role="status" class="text-sm text-gray-600 dark:text-dark-300">{{ t('admin.accountPool.loading') }}</p>
    <form v-else class="grid gap-3 sm:grid-cols-2" aria-describedby="pool-publish-help" @submit.prevent="publish">
      <fieldset :disabled="pending" class="contents">
        <label class="text-sm">{{ t('admin.accountPool.groupBinding') }}
          <select v-model="groupId" required class="input mt-1">
            <option disabled value="">{{ t('admin.accountPool.publishChoose') }}</option>
            <option v-for="group in groups" :key="group.id" :value="group.id" :disabled="group.status !== 'active'">{{ group.name }}</option>
          </select>
        </label>
        <label class="text-sm">{{ t('admin.accountPool.publishNativeGroup') }}
          <select v-model="nativeGroupId" required class="input mt-1">
            <option disabled value="">{{ t('admin.accountPool.publishChoose') }}</option>
            <option v-for="group in nativeGroups" :key="group.id" :value="group.id">{{ group.name }}</option>
          </select>
        </label>
        <label class="text-sm">{{ t('admin.accountPool.concurrency') }}
          <input v-model.number="concurrency" type="number" min="1" max="256" step="1" required class="input mt-1 tabular-nums" />
        </label>
        <button type="submit" class="btn btn-primary self-end" :disabled="!nativeGroups.length || !groups.length">{{ t(pending ? 'admin.accountPool.working' : 'admin.accountPool.publishSave') }}</button>
      </fieldset>
    </form>
    <p v-if="!loading && !nativeGroups.length" class="text-sm text-gray-600 dark:text-dark-300">{{ t('admin.accountPool.publishNoNative') }} <RouterLink to="/admin/groups" class="text-primary-600 underline dark:text-primary-400">{{ t('admin.accountPool.publishManageGroups') }}</RouterLink></p>
    <ul v-if="publications.length" class="divide-y divide-gray-100 dark:divide-dark-700">
      <li v-for="link in publications" :key="link.native_account_id" class="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
        <div class="min-w-0"><p class="break-all font-medium">{{ groups.find(group => group.id === link.group_id)?.name || link.group_id }}</p><p class="text-gray-600 dark:text-dark-300">{{ t(link.published ? 'admin.accountPool.publishActive' : 'admin.accountPool.publishInactive') }} · {{ link.native_group_ids.map(id => nativeGroups.find(group => group.id === id)?.name || id).join(', ') }}</p></div>
        <button v-if="link.published" type="button" class="btn btn-secondary btn-sm" :disabled="pending" @click="revoke = link">{{ t('admin.accountPool.publishRevoke') }}</button>
      </li>
    </ul>
  </section>
  <ConfirmDialog :show="!!revoke" :title="t('admin.accountPool.publishRevoke')" :message="t('admin.accountPool.publishRevokeHint')" danger @cancel="revoke = null" @confirm="unpublish" />
</template>
