<script setup lang="ts">
// The env file rules every repo without its own uses, kept in the vault for
// every machine. Patterns only: no values here.
import { computed, onMounted, ref, watch } from 'vue'
import { RESERVED_NOTE } from '../../../shared/envrules'
import { call, loadRepos, store, toast } from '../store'
import { patternLines, patternListProblems } from '../status'
import PatternList from './PatternList.vue'

const emit = defineEmits<{ close: [] }>()

const dialog = ref<HTMLDialogElement | null>(null)
const busy = ref(false)
const error = ref<string | null>(null)

const saved = computed(() => store.repoSettings?.defaults ?? { include: ['.env'], exclude: [] })
const includeText = ref(saved.value.include.join('\n'))
const excludeText = ref(saved.value.exclude.join('\n'))

const problems = computed(() => [
  ...patternListProblems(includeText.value),
  ...patternListProblems(excludeText.value)
])
const draft = computed(() => ({
  include: patternLines(includeText.value),
  exclude: patternLines(excludeText.value)
}))
const dirty = computed(
  () =>
    draft.value.include.join('\n') !== saved.value.include.join('\n') ||
    draft.value.exclude.join('\n') !== saved.value.exclude.join('\n')
)

// Repos that use at least one of the default lists.
const using = computed(() => {
  const own = store.repoSettings?.repos ?? {}
  return store.repoInfo.filter((r) => {
    const rules = own[r.vaultName.toLowerCase()]
    return !rules || rules.include === null || rules.exclude === null
  }).length
})

async function save(): Promise<void> {
  if (busy.value || problems.value.length || !dirty.value) return
  busy.value = true
  error.value = null
  // Plain values only: IPC can't clone reactive ones.
  const rules = { include: [...draft.value.include], exclude: [...draft.value.exclude] }
  const res = await call(() => window.envvault.saveDefaults(rules))
  busy.value = false
  if (res.ok) {
    toast('success', 'Saved the defaults.')
    await loadRepos()
    emit('close')
  } else if (res.error.code !== 'LOCKED') {
    error.value = res.error.message
  }
}

onMounted(() => dialog.value?.showModal())

// Close if the session locks while the dialog is open.
watch(
  () => store.lockEpoch,
  () => emit('close')
)
</script>

<template>
  <dialog
    ref="dialog"
    class="dialog dialog-wide"
    aria-labelledby="defaults-title"
    @cancel.prevent="emit('close')"
  >
    <div class="dialog-header">
      <h2 id="defaults-title">Env files every repo syncs</h2>
      <p class="muted small">
        Repos without their own lists use these, on every machine. {{ using }}
        {{ using === 1 ? 'repo does' : 'repos do' }} now.
      </p>
    </div>

    <div class="dialog-body stack">
      <PatternList
        id="defaults-include"
        v-model:text="includeText"
        label="Env files to sync"
        hint="One per line. A name matches in every folder (.env, .env.local, .env.*); a path is from the repo root (apps/*/.env.local)."
        :disabled="busy"
      />
      <PatternList
        id="defaults-exclude"
        v-model:text="excludeText"
        label="Env files not to sync"
        hint="Wins over the list above. A folder covers everything in it (apps/legacy, **/fixtures)."
        :disabled="busy"
      />
      <p class="muted small">{{ RESERVED_NOTE }}</p>
      <p class="muted small">
        Variants such as .env.local often hold values that differ from machine to machine. Sync them
        only where they don't, or mark those keys with # envvault:local.
      </p>
      <p v-if="error" class="notice notice-error" role="alert">{{ error }}</p>
    </div>

    <div class="dialog-footer">
      <button type="button" class="btn" :disabled="busy" @click="emit('close')">Cancel</button>
      <button
        type="button"
        class="btn btn-primary"
        :disabled="busy || !dirty || problems.length > 0"
        @click="save"
      >
        <span v-if="busy" class="spinner" />
        Save
      </button>
    </div>
  </dialog>
</template>
