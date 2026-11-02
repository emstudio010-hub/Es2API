<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { traceTriggers, type TraceConfig } from '@/api/admin/integrationModeltrace'
import TraceMinutesField from './TraceMinutesField.vue'
const props = defineProps<{ modelValue: TraceConfig }>()
const emit = defineEmits<{ 'update:modelValue': [value: TraceConfig] }>()
const { t } = useI18n()
const presets: { id: string; patch: Partial<TraceConfig> }[] = [
  { id: 'count10', patch: { trigger: 'requests', every_requests: 10, cooldown_seconds: 0 } },
  { id: 'count50', patch: { trigger: 'requests', every_requests: 50, cooldown_seconds: 0 } },
  { id: 'fixed5', patch: { trigger: 'interval', interval_seconds: 300, cooldown_seconds: 0 } },
  { id: 'fixed10', patch: { trigger: 'interval', interval_seconds: 600, cooldown_seconds: 0 } },
  { id: 'fixed30', patch: { trigger: 'interval', interval_seconds: 1800, cooldown_seconds: 0 } },
  { id: 'active10', patch: { trigger: 'active_interval', interval_seconds: 600, cooldown_seconds: 0 } },
  { id: 'and20', patch: { trigger: 'requests_and_interval', every_requests: 20, interval_seconds: 900, cooldown_seconds: 0 } },
  { id: 'or10', patch: { trigger: 'both', every_requests: 10, interval_seconds: 900, cooldown_seconds: 0 } },
  { id: 'random10', patch: { trigger: 'probability', sampling_probability: 0.1, cooldown_seconds: 600 } },
  { id: 'idle30', patch: { trigger: 'idle_return', idle_seconds: 1800, cooldown_seconds: 300 } }
]
function update<K extends keyof TraceConfig>(key: K, value: TraceConfig[K]) {
  emit('update:modelValue', { ...props.modelValue, [key]: value })
}
function number(
  key:
    | 'every_requests'
    | 'sample_count'
    | 'confidence_threshold'
    | 'consecutive_mismatches'
    | 'timeout_ms',
  event: Event
) {
  update(key, (event.target as HTMLInputElement).valueAsNumber)
}
</script>

<template>
  <div class="space-y-4">
    <div class="space-y-2 rounded-xl bg-gray-50 p-3 dark:bg-dark-800">
      <p class="text-sm font-medium">{{ t('admin.modeltrace.policy.presets') }}</p>
      <p class="text-xs text-gray-500">{{ t('admin.modeltrace.policy.presetsHint') }}</p>
      <div class="flex flex-wrap gap-2">
        <button v-for="preset in presets" :key="preset.id" type="button" class="btn btn-secondary btn-sm" :data-test="`preset-${preset.id}`" @click="emit('update:modelValue', { ...modelValue, ...preset.patch })">
          {{ t(`admin.modeltrace.presets.${preset.id}`) }}
        </button>
      </div>
    </div>
    <label class="flex items-center gap-2 text-sm font-medium"
      ><input
        type="checkbox"
        :checked="modelValue.enabled"
        @change="update('enabled', ($event.target as HTMLInputElement).checked)"
      />{{ t('admin.modeltrace.policy.enabled') }}</label
    >
    <div class="grid gap-4 sm:grid-cols-2">
      <label class="space-y-1 text-sm"
        ><span>{{ t('admin.modeltrace.policy.trigger') }}</span
        ><select
          :value="modelValue.trigger"
          class="input"
          @change="
            update(
              'trigger',
              ($event.target as HTMLSelectElement)
                .value as TraceConfig['trigger']
            )
          "
        >
          <option
            v-for="value in traceTriggers"
            :key="value"
            :value="value"
          >
            {{ t(`admin.modeltrace.triggers.${value}`) }}
          </option>
        </select></label
      >
      <label class="space-y-1 text-sm"
        ><span>{{ t('admin.modeltrace.policy.modelMode') }}</span
        ><select
          :value="modelValue.model_mode"
          class="input"
          @change="
            update(
              'model_mode',
              ($event.target as HTMLSelectElement)
                .value as TraceConfig['model_mode']
            )
          "
        >
          <option value="specified">
            {{ t('admin.modeltrace.policy.specified') }}
          </option>
          <option value="most_used">
            {{ t('admin.modeltrace.policy.mostUsed') }}
          </option>
        </select></label
      >
      <label
        v-if="
          ['requests', 'both', 'requests_and_interval'].includes(modelValue.trigger)
        "
        class="space-y-1 text-sm"
        ><span>{{ t('admin.modeltrace.policy.everyRequests') }}</span
        ><input
          :value="modelValue.every_requests"
          type="number"
          min="1"
          max="1000000"
          step="1"
          required
          class="input"
          @input="number('every_requests', $event)"
      /></label>
      <TraceMinutesField
        v-if="['interval', 'both', 'requests_and_interval', 'active_interval'].includes(modelValue.trigger)"
        :model-value="modelValue.interval_seconds"
        :label="t('admin.modeltrace.policy.interval')"
        presets
        test-id="interval-minutes"
        @update:model-value="update('interval_seconds', $event)"
      />
      <label v-if="modelValue.trigger === 'probability'" class="space-y-1 text-sm">
        <span>{{ t('admin.modeltrace.policy.probability') }}</span>
        <input :value="(modelValue.sampling_probability ?? 0.1) * 100" type="number" min="1" max="100" step="any" required class="input" data-test="sampling-percent" @input="update('sampling_probability', ($event.target as HTMLInputElement).valueAsNumber / 100)" />
      </label>
      <TraceMinutesField
        v-if="modelValue.trigger === 'idle_return'"
        :model-value="modelValue.idle_seconds ?? 1800"
        :label="t('admin.modeltrace.policy.idle')"
        test-id="idle-minutes"
        @update:model-value="update('idle_seconds', $event)"
      />
      <TraceMinutesField
        v-if="modelValue.trigger !== 'manual'"
        :model-value="modelValue.cooldown_seconds ?? 0"
        :label="t('admin.modeltrace.policy.cooldown')"
        :min-seconds="0"
        test-id="cooldown-minutes"
        @update:model-value="update('cooldown_seconds', $event)"
      />
      <label class="space-y-1 text-sm"
        ><span>{{
          t(
            modelValue.model_mode === 'most_used'
              ? 'admin.modeltrace.policy.fallbackModel'
              : 'admin.modeltrace.policy.model'
          )
        }}</span
        ><input
          :value="modelValue.model"
          type="text"
          maxlength="150"
          pattern="[a-zA-Z0-9][a-zA-Z0-9._:\/\-]{0,149}"
          required
          class="input"
          @input="update('model', ($event.target as HTMLInputElement).value)"
      /></label>
      <label class="space-y-1 text-sm"
        ><span>{{ t('admin.modeltrace.policy.sampleCount') }}</span
        ><input
          :value="modelValue.sample_count"
          type="number"
          min="3"
          max="10"
          step="1"
          required
          class="input"
          @input="number('sample_count', $event)"
      /></label>
      <label class="space-y-1 text-sm"
        ><span>{{ t('admin.modeltrace.policy.threshold') }}</span
        ><input
          :value="modelValue.confidence_threshold"
          type="number"
          min="0.5"
          max="1"
          step="0.01"
          required
          class="input"
          @input="number('confidence_threshold', $event)"
      /></label>
      <label class="space-y-1 text-sm"
        ><span>{{ t('admin.modeltrace.policy.consecutive') }}</span
        ><input
          :value="modelValue.consecutive_mismatches"
          type="number"
          min="1"
          max="20"
          step="1"
          required
          class="input"
          @input="number('consecutive_mismatches', $event)"
      /></label>
      <label class="space-y-1 text-sm"
        ><span>{{ t('admin.modeltrace.policy.action') }}</span
        ><select
          :value="modelValue.action"
          class="input"
          @change="
            update(
              'action',
              ($event.target as HTMLSelectElement)
                .value as TraceConfig['action']
            )
          "
        >
          <option
            v-for="value in ['observe', 'deprioritize', 'pause']"
            :key="value"
            :value="value"
          >
            {{ t(`admin.modeltrace.actions.${value}`) }}
          </option>
        </select></label
      >
      <label class="space-y-1 text-sm"
        ><span>{{ t('admin.modeltrace.policy.timeout') }}</span
        ><input
          :value="modelValue.timeout_ms"
          type="number"
          min="1000"
          max="300000"
          step="1"
          required
          class="input"
          @input="number('timeout_ms', $event)"
      /></label>
    </div>
    <div class="rounded-xl border border-primary-100 p-3 text-sm dark:border-dark-700" role="note">
      <p>{{ t(`admin.modeltrace.triggerHelp.${modelValue.trigger}`) }}</p>
      <p class="mt-2 text-xs text-gray-500">{{ t('admin.modeltrace.policy.cooldownHint') }}</p>
    </div>
    <p class="text-xs text-gray-500 dark:text-dark-400">
      {{ t('admin.modeltrace.policy.modelHint') }}
    </p>
  </div>
</template>
