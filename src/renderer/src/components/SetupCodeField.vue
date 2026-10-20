<script setup lang="ts">
// Shows this machine's setup code for the vault, for setting up another
// machine. Main checks the password again first. The code is a credential:
// it lives only in this component's refs, and is hidden again after a
// minute, when the window is hidden, when you leave Settings' General tab
// and when the vault locks.
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { call, store } from '../store'

const SHOW_MS = 60_000

const used = computed(() => store.app?.setupCode !== 'not-used')
const asking = ref(false)
const password = ref('')
const code = ref<string | null>(null)
const busy = ref(false)
const error = ref<string | null>(null)
let timer: ReturnType<typeof setTimeout> | null = null

function hide(): void {
  code.value = null
  password.value = ''
  asking.value = false
  error.value = null
  if (timer) clearTimeout(timer)
  timer = null
}

async function show(): Promise<void> {
  if (busy.value || !password.value) return
  busy.value = true
  error.value = null
  const pw = password.value
  const res = await call(() => window.envvault.showSetupCode(pw))
  password.value = ''
  busy.value = false
  if (!res.ok) {
    error.value = res.error.message
    return
  }
  asking.value = false
  code.value = res.data.setupCode
  timer = setTimeout(hide, SHOW_MS)
}

const onVisibility = (): void => {
  if (document.hidden) hide()
}
onMounted(() => document.addEventListener('visibilitychange', onVisibility))
onBeforeUnmount(() => {
  document.removeEventListener('visibilitychange', onVisibility)
  hide()
})
watch(() => store.lockEpoch, hide)
watch(
  () => store.settingsTab,
  (tab) => {
    if (tab !== 'general') hide()
  }
)
</script>

<template>
  <div class="field">
    <label>Setup code</label>
    <p v-if="!used" class="muted small">
      Not used by this vault: it opens with the master password alone.
    </p>
    <template v-else>
      <div v-if="code" class="stack">
        <div class="setup-code" tabindex="0" aria-label="Setup code">{{ code }}</div>
        <div class="row">
          <span class="muted small grow">Hidden again in a minute.</span>
          <button type="button" class="btn btn-sm" @click="hide">Hide</button>
        </div>
      </div>
      <!-- Inside Settings' form: Enter is handled here, not submitted. -->
      <div v-else-if="asking" class="row">
        <input
          v-model="password"
          class="input grow"
          type="password"
          placeholder="Master password"
          aria-label="Master password"
          autocomplete="off"
          spellcheck="false"
          :disabled="busy"
          @keydown.enter.prevent="show"
        />
        <button type="button" class="btn btn-sm" :disabled="busy || !password" @click="show">
          <span v-if="busy" class="spinner" />
          Show
        </button>
        <button type="button" class="btn btn-sm" :disabled="busy" @click="hide">Cancel</button>
      </div>
      <div v-else class="folder">
        <span class="skill-state">Kept on this machine</span>
        <button type="button" class="btn btn-sm" @click="asking = true">Show…</button>
      </div>
      <p v-if="error" class="notice notice-error" role="alert">{{ error }}</p>
      <p class="muted small">
        Another machine needs it once, with the master password, to unlock this vault.
      </p>
    </template>
  </div>
</template>
