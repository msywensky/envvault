<script setup lang="ts">
// One list of env file patterns (see src/shared/envrules.ts), one per line: a
// repo's include or exclude list, or the defaults'. Given `defaults`, it can
// use those instead, and starts from them when it stops.
import { computed } from 'vue'
import { patternListProblems } from '../status'

const props = defineProps<{
  id: string
  label: string
  hint: string
  text: string
  /** The defaults this list can use instead; leave out for the defaults themselves. */
  defaults?: string[]
  useDefaults?: boolean
  disabled?: boolean
}>()
const emit = defineEmits<{ 'update:text': [text: string]; 'update:useDefaults': [on: boolean] }>()

const usingDefaults = computed(() => props.defaults !== undefined && props.useDefaults === true)
const problems = computed(() => (usingDefaults.value ? [] : patternListProblems(props.text)))
const defaultsText = computed(() => (props.defaults?.length ? props.defaults.join(', ') : 'none'))

function toggle(event: Event): void {
  const on = (event.target as HTMLInputElement).checked
  // Stop using the defaults: start from them.
  if (!on && props.text.trim() === '') emit('update:text', (props.defaults ?? []).join('\n'))
  emit('update:useDefaults', on)
}
</script>

<template>
  <div class="field">
    <label :for="id">{{ label }}</label>
    <label v-if="defaults" class="checkbox">
      <input type="checkbox" :checked="usingDefaults" :disabled="disabled" @change="toggle" />
      <span>Use the defaults: {{ defaultsText }}</span>
    </label>
    <textarea
      v-if="!usingDefaults"
      :id="id"
      :value="text"
      class="input pattern-text"
      rows="3"
      spellcheck="false"
      autocomplete="off"
      autocapitalize="off"
      :disabled="disabled"
      :aria-invalid="problems.length > 0"
      @input="emit('update:text', ($event.target as HTMLTextAreaElement).value)"
    />
    <p class="muted small">{{ hint }}</p>
    <p v-for="problem in problems" :key="problem" class="small editor-problem">{{ problem }}</p>
  </div>
</template>
