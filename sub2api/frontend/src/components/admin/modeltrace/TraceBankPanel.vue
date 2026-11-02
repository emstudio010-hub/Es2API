<script setup lang="ts">
import { onUnmounted, ref, shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'
import {
  modeltraceApi,
  parseTraceBank,
  type TraceBank,
  type TraceBankInput
} from '@/api/admin/integrationModeltrace'
import { integrationErrorMessage } from '@/api/admin/integrationClient'
defineProps<{ bank: TraceBank }>()
const emit = defineEmits<{ changed: [] }>()
const { t } = useI18n()
const source = ref(''),
  error = ref(''),
  saved = ref(false),
  saving = ref(false),
  reading = ref(false)
const pending = shallowRef<TraceBankInput | null>(null)
const example =
  '{ "challenges": [{ "id": "challenge-1", "prompt": "…" }], "models": [{ "id": "model-name", "responses": [{ "challenge_id": "challenge-1", "text": "…" }] }] }'
let disposed = false
onUnmounted(() => {
  disposed = true
})
async function readFile(event: Event) {
  const input = event.target as HTMLInputElement,
    file = input.files?.[0]
  if (!file) return
  error.value = ''
  saved.value = false
  if (file.size > 10 * 1024 * 1024) {
    error.value = t('admin.modeltrace.bank.tooLarge')
    input.value = ''
    return
  }
  reading.value = true
  try {
    const value = await file.text()
    if (!disposed) source.value = value
  } catch {
    if (!disposed) error.value = t('admin.modeltrace.bank.readFailed')
  } finally {
    if (!disposed) {
      reading.value = false
      input.value = ''
    }
  }
}
function review() {
  error.value = ''
  saved.value = false
  if (new TextEncoder().encode(source.value).length > 10 * 1024 * 1024) {
    error.value = t('admin.modeltrace.bank.tooLarge')
    return
  }
  try {
    pending.value = parseTraceBank(source.value)
  } catch {
    error.value = t('admin.modeltrace.bank.invalid')
  }
}
async function install() {
  if (!pending.value || saving.value) return
  const payload = pending.value
  pending.value = null
  saving.value = true
  error.value = ''
  try {
    await modeltraceApi.installBank(payload)
    if (!disposed) {
      source.value = ''
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
    <div class="mb-3 flex flex-wrap items-center justify-between gap-3">
      <h2 class="text-lg font-semibold">
        {{ t('admin.modeltrace.bank.title') }}
      </h2>
      <span
        class="rounded-full px-3 py-1 text-xs font-medium"
        :class="
          bank.ready
            ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
            : 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
        "
        >{{
          t(
            bank.ready
              ? 'admin.modeltrace.bank.ready'
              : 'admin.modeltrace.bank.missing'
          )
        }}</span
      >
    </div>
    <p class="text-sm text-gray-500 dark:text-dark-400">
      {{ t('admin.modeltrace.bank.requirements') }}
    </p>
    <p v-if="bank.method === 'shared-detector-v2'" class="mt-3 text-sm text-gray-500 dark:text-dark-400">{{ t('admin.modeltrace.bank.builtin') }}</p>
    <p v-if="bank.source" class="mt-2 break-all text-xs text-gray-500">{{ bank.source }}</p>
    <p v-if="bank.method === 'text-similarity'" class="mt-3 text-sm text-amber-600">{{ t('admin.modeltrace.bank.textMode') }}</p>
    <dl class="my-4 grid gap-3 text-sm sm:grid-cols-2">
      <div>
        <dt class="text-gray-500">
          {{ t('admin.modeltrace.bank.challenges') }}
        </dt>
        <dd class="mt-1 font-medium">{{ bank.challenges.length }}</dd>
      </div>
      <div>
        <dt class="text-gray-500">{{ t('admin.modeltrace.bank.models') }}</dt>
        <dd class="mt-1 break-words font-medium">
          {{ bank.models.join(', ') || '—' }}
        </dd>
      </div>
      <div class="sm:col-span-2">
        <dt class="text-gray-500">{{ t('admin.modeltrace.bank.revision') }}</dt>
        <dd class="mt-1 break-all font-mono text-xs">
          {{ bank.revision || '—' }}
        </dd>
      </div>
    </dl>
    <details class="border-t border-gray-100 pt-4 dark:border-dark-700">
      <summary class="cursor-pointer text-sm font-medium text-primary-600">
        {{ t('admin.modeltrace.bank.import') }}
      </summary>
      <div class="mt-4 space-y-3">
        <p class="text-sm text-gray-500 dark:text-dark-400">
          {{ t('admin.modeltrace.bank.format') }}
        </p>
        <label class="block space-y-1 text-sm"
          ><span>{{ t('admin.modeltrace.bank.file') }}</span
          ><input
            type="file"
            accept="application/json,.json"
            :disabled="saving || reading"
            class="block w-full text-sm"
            @change="readFile"
        /></label>
        <label class="block space-y-1 text-sm"
          ><span>{{ t('admin.modeltrace.bank.json') }}</span
          ><textarea
            v-model="source"
            rows="7"
            spellcheck="false"
            :disabled="saving || reading"
            class="input font-mono text-xs"
            :placeholder="example"
          />
        </label>
        <p v-if="error" role="alert" class="text-sm text-red-600">
          {{ error }}
        </p>
        <p v-if="saved" role="status" class="text-sm text-green-600">
          {{ t('admin.modeltrace.bank.saved') }}
        </p>
        <button
          type="button"
          class="btn btn-primary"
          :disabled="saving || reading || !source.trim()"
          @click="review"
        >
          {{
            t(
              saving
                ? 'admin.modeltrace.saving'
                : reading
                  ? 'admin.modeltrace.loading'
                  : 'admin.modeltrace.bank.review'
            )
          }}
        </button>
      </div>
    </details>
    <ConfirmDialog
      :show="!!pending"
      :title="t('admin.modeltrace.bank.confirmTitle')"
      :message="
        t('admin.modeltrace.bank.confirm', {
          challenges: pending?.challenges.length || 0,
          models: pending?.models.length || 0
        })
      "
      danger
      @cancel="pending = null"
      @confirm="install"
    />
  </section>
</template>
