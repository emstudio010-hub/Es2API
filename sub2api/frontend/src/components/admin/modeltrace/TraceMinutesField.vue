<script setup lang="ts">
import { computed, onMounted, shallowRef, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'

const props = withDefaults(defineProps<{
  modelValue: number
  label: string
  minSeconds?: number
  presets?: boolean
  testId: string
}>(), { minSeconds: 60, presets: false })
const emit = defineEmits<{ 'update:modelValue': [seconds: number] }>()
const { t } = useI18n()
const id = useId()
const input = shallowRef<HTMLInputElement | null>(null)
const custom = shallowRef(false)
const choices = [5, 10, 15, 30, 60]
const choice = computed(() => !custom.value && choices.includes(props.modelValue / 60)
  ? String(props.modelValue / 60) : 'custom')
const showInput = computed(() => !props.presets || choice.value === 'custom')
function select(event: Event) {
  const value = (event.target as HTMLSelectElement).value
  custom.value = value === 'custom'
  if (!custom.value) emit('update:modelValue', Number(value) * 60)
}
function update(event: Event) {
  const value = (event.target as HTMLInputElement).valueAsNumber * 60
  const seconds = Math.abs(value - Math.round(value)) < 1e-7 ? Math.round(value) : value
  emit('update:modelValue', seconds)
}
function validate() {
  input.value?.setCustomValidity(Number.isInteger(props.modelValue) ? '' : t('admin.modeltrace.policy.wholeSeconds'))
}
watch(() => props.modelValue, validate, { flush: 'post' })
onMounted(validate)
</script>

<template>
  <div class="space-y-1 text-sm" :data-test="testId">
    <label :for="presets ? `${id}-choice` : `${id}-value`">{{ label }}</label>
    <select v-if="presets" :id="`${id}-choice`" :value="choice" class="input" @change="select">
      <option v-for="minutes in choices" :key="minutes" :value="String(minutes)">{{ t('admin.modeltrace.policy.minutesValue', { count: minutes }) }}</option>
      <option value="custom">{{ t('admin.modeltrace.policy.customMinutes') }}</option>
    </select>
    <template v-if="showInput">
      <label v-if="presets" :for="`${id}-value`" class="sr-only">{{ label }} · {{ t('admin.modeltrace.policy.customMinutes') }}</label>
      <input
        :id="`${id}-value`"
        ref="input"
        :value="modelValue / 60"
        :aria-describedby="`${id}-seconds`"
        type="number"
        :min="minSeconds / 60"
        max="10080"
        step="any"
        required
        class="input"
        @input="update"
      />
      <p :id="`${id}-seconds`" class="text-xs text-gray-600 dark:text-dark-300">{{ t('admin.modeltrace.policy.exactSeconds', { count: modelValue }) }}</p>
    </template>
  </div>
</template>
