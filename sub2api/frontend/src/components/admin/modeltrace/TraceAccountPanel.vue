<script setup lang="ts">
import { computed, onUnmounted, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'
import TracePolicyFields from './TracePolicyFields.vue'
import {
  modeltraceApi,
  type TraceAccountConfig,
  type TraceAccountSummary,
  type TraceConfig
} from '@/api/admin/integrationModeltrace'
import { integrationErrorMessage } from '@/api/admin/integrationClient'
const props = withDefaults(defineProps<{
  accounts: TraceAccountSummary[]
  bankReady: boolean
  refreshKey: number
  initialAccount?: string
  globalEnabled?: boolean
}>(), { globalEnabled: true })
const emit = defineEmits<{ changed: []; selected: [id: string] }>()
const { t } = useI18n()
const selected = ref(''),
  info = shallowRef<TraceAccountConfig | null>(null),
  draft = ref<TraceConfig | null>(null)
const inherit = ref(true),
  loading = ref(false),
  busy = ref(false),
  error = ref(''),
  notice = ref('')
type Pending = {
  kind: 'run' | 'reset' | 'save'
  id: string
  data?: Partial<TraceConfig> & { inherit?: boolean }
}
const pending = shallowRef<Pending | null>(null)
let disposed = false,
  generation = 0,
  controller: AbortController | undefined
const draftValue = () =>
  JSON.stringify(inherit.value ? { inherit: true } : draft.value)
const baseline = ref('')
const dirty = computed(() => draftValue() !== baseline.value)
const automaticOn = computed(() => !!info.value?.effective_config.enabled && info.value.effective_config.trigger !== 'manual')
const confirmation = computed(() =>
  pending.value
    ? t(`admin.modeltrace.account.confirm${pending.value.kind}`, {
        id: pending.value.id,
        count: info.value?.effective_config.sample_count || 0
      })
    : ''
)
function resetDraft() {
  if (!info.value) return
  inherit.value = Object.keys(info.value.overrides).length === 0
  draft.value = { ...info.value.effective_config, ...info.value.overrides }
  baseline.value = draftValue()
}
watch(
  () => props.accounts,
  (accounts) => {
    if (!accounts.some((account) => account.account_id === selected.value))
      selected.value =
        accounts.find((account) => account.account_id === props.initialAccount)
          ?.account_id ||
        accounts[0]?.account_id ||
        ''
  },
  { immediate: true }
)
watch(
  selected,
  () => {
    info.value = null
    draft.value = null
    notice.value = ''
    pending.value = null
    emit('selected', selected.value)
    void load(true)
  },
  { immediate: true }
)
watch(
  [() => props.initialAccount, busy],
  ([id]) => {
    if (
      id &&
      !busy.value &&
      props.accounts.some((account) => account.account_id === id)
    )
      selected.value = id
  }
)
watch(
  () => props.refreshKey,
  () => {
    if (!busy.value) void load(false)
  }
)
async function load(reset: boolean) {
  controller?.abort()
  controller = new AbortController()
  const request = ++generation
  if (!selected.value) {
    loading.value = false
    return
  }
  loading.value = true
  error.value = ''
  try {
    const value = await modeltraceApi.account(selected.value, controller.signal)
    if (disposed || request !== generation) return
    const replace = reset || !dirty.value
    info.value = value
    if (replace) resetDraft()
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
function prepare(kind: Pending['kind']) {
  if (busy.value || !info.value) return
  pending.value = {
    kind,
    id: selected.value,
    ...(kind === 'save'
      ? { data: inherit.value ? { inherit: true } : { ...draft.value! } }
      : {})
  }
}
async function execute() {
  if (!pending.value || busy.value) return
  const action = pending.value
  pending.value = null
  busy.value = true
  error.value = ''
  notice.value = ''
  try {
    if (action.kind === 'run') await modeltraceApi.run(action.id)
    else if (action.kind === 'reset') await modeltraceApi.resetAction(action.id)
    else await modeltraceApi.saveAccount(action.id, action.data!)
    if (disposed) return
    notice.value = t(
      action.kind === 'run'
        ? 'admin.modeltrace.account.queued'
        : 'admin.modeltrace.saved'
    )
    await load(action.kind === 'save')
    emit('changed')
  } catch (cause) {
    if (!disposed)
      error.value = integrationErrorMessage(
        cause,
        t('admin.modeltrace.requestFailed')
      )
  } finally {
    if (!disposed) busy.value = false
  }
}
async function toggleAutomatic() {
  if (busy.value || loading.value || dirty.value || !info.value) return
  const enable = !automaticOn.value
  if (enable && props.globalEnabled === false) return
  busy.value = true
  error.value = ''
  notice.value = ''
  try {
    await modeltraceApi.saveAccount(selected.value, enable
      ? { enabled: true, trigger: info.value.effective_config.trigger === 'manual' ? 'requests' : info.value.effective_config.trigger }
      : { enabled: false })
    if (disposed) return
    notice.value = t('admin.modeltrace.saved')
    await load(true)
    emit('changed')
  } catch (cause) {
    if (!disposed) error.value = integrationErrorMessage(cause, t('admin.modeltrace.requestFailed'))
  } finally {
    if (!disposed) busy.value = false
  }
}
onUnmounted(() => {
  disposed = true
  generation++
  controller?.abort()
})
</script>

<template>
  <section class="card p-5">
    <h2 class="mb-1 text-lg font-semibold">
      {{ t('admin.modeltrace.account.title') }}
    </h2>
    <p class="mb-4 text-sm text-gray-500 dark:text-dark-400">
      {{ t('admin.modeltrace.account.description') }}
    </p>
    <p v-if="!accounts.length" class="py-5 text-sm text-gray-500">
      {{ t('admin.modeltrace.account.empty') }}
    </p>
    <template v-else>
      <label class="block max-w-xl space-y-1 text-sm"
        ><span>{{ t('admin.modeltrace.account.select') }}</span
        ><select v-model="selected" :disabled="busy" class="input">
          <option
            v-for="account in accounts"
            :key="account.account_id"
            :value="account.account_id"
          >
            {{ account.account_id }} ·
            {{
              t(
                account.enabled
                  ? 'admin.modeltrace.enabled'
                  : 'admin.modeltrace.disabled'
              )
            }}
          </option>
        </select></label
      >
      <p v-if="error" role="alert" class="mt-3 text-sm text-red-600">
        {{ error }}
        <button
          v-if="!busy"
          class="underline"
          type="button"
          @click="load(true)"
        >
          {{ t('admin.modeltrace.retry') }}
        </button>
      </p>
      <p v-if="loading" role="status" class="mt-4 text-sm text-gray-500">
        {{ t('admin.modeltrace.loading') }}
      </p>
      <template v-if="info && draft">
        <div class="mt-4 rounded-xl border border-gray-200 p-4 dark:border-dark-700">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 class="text-sm font-semibold">{{ t('admin.modeltrace.automation.accountTitle') }}</h3>
              <p class="mt-1 text-xs text-gray-500">{{ t('admin.modeltrace.automation.accountHint', { trigger: t(`admin.modeltrace.triggers.${info.effective_config.trigger}`), samples: info.effective_config.sample_count }) }}</p>
            </div>
            <button
              type="button"
              class="btn btn-secondary"
              data-test="toggle-automatic"
              :disabled="busy || loading || dirty || (!automaticOn && globalEnabled === false)"
              @click="toggleAutomatic"
            >
              {{ t(automaticOn ? 'admin.modeltrace.automation.disable' : 'admin.modeltrace.automation.enable') }}
            </button>
          </div>
          <p v-if="globalEnabled === false" class="mt-2 text-xs text-amber-600">{{ t('admin.modeltrace.automation.enableGlobalFirst') }}</p>
          <p v-if="dirty" class="mt-2 text-xs text-amber-600">{{ t('admin.modeltrace.automation.saveDraftFirst') }}</p>
          <p v-if="info.automation?.cooldown_until && (info.automation.cooldown_remaining_seconds || 0) > 0" class="mt-2 text-xs text-gray-500">{{ t('admin.modeltrace.automation.cooldownRemaining', { seconds: info.automation.cooldown_remaining_seconds }) }}</p>
          <ul v-if="info.automation?.blocked_reasons.length" class="mt-3 list-inside list-disc text-xs text-gray-500">
            <li v-for="reason in info.automation.blocked_reasons" :key="reason">{{ t(`admin.modeltrace.readiness.${reason}`) }}</li>
          </ul>
        </div>
        <dl class="my-4 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <dt class="text-gray-500">
              {{ t('admin.modeltrace.account.effective') }}
            </dt>
            <dd class="mt-1">
              {{
                t(
                  info.effective_config.enabled
                    ? 'admin.modeltrace.enabled'
                    : 'admin.modeltrace.disabled'
                )
              }}
            </dd>
          </div>
          <div>
            <dt class="text-gray-500">
              {{ t('admin.modeltrace.account.actionState') }}
            </dt>
            <dd class="mt-1">
              {{
                t(
                  info.state.auto_paused
                    ? 'admin.modeltrace.actions.pause'
                    : info.state.deprioritized
                      ? 'admin.modeltrace.actions.deprioritize'
                      : 'admin.modeltrace.actions.none'
                )
              }}
            </dd>
          </div>
          <div>
            <dt class="text-gray-500">
              {{ t('admin.modeltrace.account.consecutive') }}
            </dt>
            <dd class="mt-1">{{ info.state.consecutive || 0 }}</dd>
          </div>
          <div>
            <dt class="text-gray-500">
              {{ t('admin.modeltrace.account.latest') }}
            </dt>
            <dd class="mt-1">
              {{
                info.state.last_status
                  ? t(`admin.modeltrace.status.${info.state.last_status}`)
                  : '—'
              }}
            </dd>
          </div>
        </dl>
        <div class="mb-4 flex flex-wrap gap-3">
          <button
            type="button"
            class="btn btn-primary"
            :disabled="busy || loading || !bankReady || info.readiness?.ready === false"
            @click="prepare('run')"
          >
            {{
              t(
                busy
                  ? 'admin.modeltrace.working'
                  : 'admin.modeltrace.account.run'
              )
            }}</button
          ><button
            type="button"
            class="btn btn-secondary"
            :disabled="
              busy ||
              loading ||
              (!info.state.auto_paused && !info.state.deprioritized)
            "
            @click="prepare('reset')"
          >
            {{ t('admin.modeltrace.account.reset') }}
          </button>
        </div>
        <p v-if="!bankReady" class="mb-4 text-sm text-amber-600">
          {{ t('admin.modeltrace.account.bankRequired') }}
        </p>
        <ul v-if="info.readiness && !info.readiness.ready" class="mb-4 list-inside list-disc text-sm text-amber-600">
          <li v-for="blocker in info.readiness.blockers" :key="blocker">{{ t(`admin.modeltrace.readiness.${blocker}`) }}</li>
        </ul>
        <p v-if="notice" role="status" class="mb-4 text-sm text-green-600">
          {{ notice }}
        </p>
        <details class="border-t border-gray-100 pt-4 dark:border-dark-700">
          <summary class="cursor-pointer text-sm font-medium text-primary-600">
            {{ t('admin.modeltrace.account.overrideTitle') }}
          </summary>
          <form class="mt-4" @submit.prevent="prepare('save')">
            <fieldset :disabled="busy || loading" class="space-y-4">
              <label class="flex items-center gap-2 text-sm"
                ><input v-model="inherit" type="checkbox" />{{
                  t('admin.modeltrace.account.inherit')
                }}</label
              >
              <p class="text-xs text-gray-500">
                {{ t('admin.modeltrace.account.inheritHint') }}
              </p>
              <TracePolicyFields v-if="!inherit" v-model="draft" />
              <div class="flex gap-3">
                <button
                  type="submit"
                  class="btn btn-primary"
                  :disabled="!dirty"
                >
                  {{
                    t(
                      busy ? 'admin.modeltrace.saving' : 'admin.modeltrace.save'
                    )
                  }}</button
                ><button
                  type="button"
                  class="btn btn-secondary"
                  :disabled="!dirty"
                  @click="resetDraft"
                >
                  {{ t('admin.modeltrace.discard') }}
                </button>
              </div>
            </fieldset>
          </form>
        </details>
      </template>
    </template>
    <ConfirmDialog
      :show="!!pending"
      :title="t('admin.modeltrace.account.confirmTitle')"
      :message="confirmation"
      :danger="pending?.kind !== 'run'"
      @cancel="pending = null"
      @confirm="execute"
    />
  </section>
</template>
