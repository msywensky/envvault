<script setup lang="ts">
// Settings' Command line tab. Access waits for Save; the skill is installed
// or removed at once, and only once access is saved.
import { computed, ref, watch } from 'vue'
import { saveSettings, store, toast, unsavedSettings } from '../store'
import SaveBar from './SaveBar.vue'
import SkillField from './SkillField.vue'

const emit = defineEmits<{ unsaved: [on: boolean] }>()

const busy = ref(false)
const cliAccess = ref(store.settings?.cliAccess ?? false)

const draft = computed(() => ({ cliAccess: cliAccess.value }))
const unsaved = computed(() => unsavedSettings(draft.value))
watch(unsaved, (on) => emit('unsaved', on), { immediate: true })

async function save(): Promise<void> {
  if (busy.value || !unsaved.value) return
  busy.value = true
  const saved = await saveSettings(draft.value)
  busy.value = false
  if (saved) toast('success', 'Settings saved.')
}
</script>

<template>
  <form class="stack" @submit.prevent="save">
    <SaveBar :busy="busy" :unsaved="unsaved" />
    <div class="card">
      <div class="card-body stack">
        <div class="field">
          <label class="checkbox">
            <input v-model="cliAccess" type="checkbox" />
            <span>Allow command-line access</span>
          </label>
          <p class="muted small">
            Lets the envvault command and the Claude Code skill check status and push while EnvVault
            is unlocked. Any program running as you can use it. It never receives values.
          </p>
        </div>
        <SkillField />
      </div>
    </div>
    <SaveBar :busy="busy" :unsaved="unsaved" />
  </form>
</template>
