<script setup lang="ts">
import { computed, onUnmounted, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'
import TracePolicyFields from './TracePolicyFields.vue'
import {
  modeltraceApi,
  type TraceConfig
} from '@/api/admin/integrationModeltrace'
import { integrationErrorMessage } from '@/api/admin/integrationClient'
const props = defineProps<{ config: TraceConfig }>()
const emit = defineEmits<{ changed: [] }>()
const { t } = useI18n()
const baseline = shallowRef({ ...props.config })
const draft = ref({ ...props.config })
const pending = shallowRef<TraceConfig | null>(null)
const saving = ref(false),
  saved = ref(false),
  error = ref('')
let disposed = false
onUnmounted(() => {
  disposed = true
})
const dirty = computed(
  () => JSON.stringify(draft.value) !== JSON.stringify(baseline.value)
)
watch(
  () => props.config,
  (value) => {
    if (!dirty.value) {
      baseline.value = { ...value }
      draft.value = { ...value }
    }
  }
)
function reset() {
  baseline.value = { ...props.config }
  draft.value = { ...props.config }
  saved.value = false
  error.value = ''
}
async function save() {
  if (!pending.value || saving.value) return
  const payload = pending.value
  pending.value = null
  saving.value = true
  saved.value = false
  error.value = ''
  try {
    const value = await modeltraceApi.saveConfig(payload)
    if (!disposed) {
      baseline.value = { ...value }
      draft.value = { ...value }
      saved.value = true
      emit('changed')
    }
  } catch (cause) {
    if (!disposed)
      error.value = integrationErrorMessage(
        cause,
        t('admin.modeltrace.requestFailed')
      )
  } finally {
    if (!disposed) saving.value = false
  }
}
</script>

<template>
  <section class="card p-5">
    <h2 class="mb-1 text-lg font-semibold">
      {{ t('admin.modeltrace.policy.title') }}
    </h2>
    <p class="mb-5 text-sm text-gray-500 dark:text-dark-400">
      {{ t('admin.modeltrace.policy.description') }}
    </p>
    <form @submit.prevent="pending = { ...draft }">
      <fieldset :disabled="saving" class="space-y-4">
        <TracePolicyFields v-model="draft" />
        <p v-if="error" role="alert" class="text-sm text-red-600">
          {{ error }}
        </p>
        <p v-if="saved" role="status" class="text-sm text-green-600">
          {{ t('admin.modeltrace.saved') }}
        </p>
        <div class="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            class="btn btn-primary"
            :disabled="!dirty || saving"
          >
            {{
              t(saving ? 'admin.modeltrace.saving' : 'admin.modeltrace.save')
            }}</button
          ><button
            type="button"
            class="btn btn-secondary"
            :disabled="!dirty || saving"
            @click="reset"
          >
            {{ t('admin.modeltrace.discard') }}</button
          ><span v-if="dirty" class="text-sm text-amber-600">{{
            t('admin.modeltrace.unsaved')
          }}</span>
        </div>
      </fieldset>
    </form>
    <ConfirmDialog
      :show="!!pending"
      :title="t('admin.modeltrace.policy.confirmTitle')"
      :message="
        t('admin.modeltrace.policy.confirm', {
          action: t(`admin.modeltrace.actions.${pending?.action || 'observe'}`)
        })
      "
      :danger="pending?.action !== 'observe'"
      @cancel="pending = null"
      @confirm="save"
    />
  </section>
</template>
