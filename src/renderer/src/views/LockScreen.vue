<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import type { Result } from '../../../shared/result'
import { call, refreshState, store } from '../store'
import { vaultLabel } from '../vault'

const MIN_CHARS = 12

const password = ref('')
const confirmPassword = ref('')
const busy = ref(false)
const error = ref<string | null>(null)
const firstInput = ref<HTMLInputElement | null>(null)

const vault = computed(() => store.app?.vault ?? 'not-configured')
// Messages differ for a synced folder and a git repository.
const git = computed(() => store.settings?.vault?.kind === 'git')
const length = computed(() => [...password.value].length)
const createProblem = computed(() => {
  if (length.value < MIN_CHARS) return `Use at least ${MIN_CHARS} characters.`
  if (confirmPassword.value && confirmPassword.value !== password.value) {
    return "The passwords don't match."
  }
  return null
})
const canCreate = computed(() => !createProblem.value && confirmPassword.value === password.value)

/** Send the password, clear the fields, and go to the repo list on success. */
async function submit(request: (password: string) => Promise<Result<unknown>>): Promise<void> {
  if (busy.value) return
  busy.value = true
  error.value = null
  const pw = password.value
  const res = await call(() => request(pw))
  password.value = ''
  confirmPassword.value = ''
  busy.value = false
  if (!res.ok) {
    error.value = res.error.message
    await focus()
    return
  }
  store.view = 'repos'
  await refreshState()
}

function unlock(): void {
  if (password.value) void submit((pw) => window.envvault.unlock(pw))
}

function create(): void {
  if (canCreate.value) void submit((pw) => window.envvault.createVault(pw, false))
}

async function recheck(): Promise<void> {
  error.value = null
  await refreshState()
}

// The autofocus attribute only works once per page load, and this screen is
// shown again after every lock, so focus explicitly.
async function focus(): Promise<void> {
  await nextTick()
  firstInput.value?.focus()
}
onMounted(focus)
watch(vault, focus)
</script>

<template>
  <main class="center-screen">
    <div class="panel card">
      <div class="card-body stack">
        <div class="panel-title">
          <span class="brand-mark" aria-hidden="true">E</span>
          <h1>EnvVault</h1>
        </div>

        <!-- Existing vault: unlock. -->
        <form v-if="vault === 'ready'" class="stack" @submit.prevent="unlock">
          <p class="muted">Enter your master password to unlock the vault.</p>
          <div class="field">
            <label for="password">Master password</label>
            <input
              id="password"
              ref="firstInput"
              v-model="password"
              class="input"
              type="password"
              autocomplete="off"
              spellcheck="false"
              :disabled="busy"
            />
          </div>
          <button type="submit" class="btn btn-primary" :disabled="busy || !password">
            <span v-if="busy" class="spinner" />
            {{ busy ? 'Unlocking…' : 'Unlock' }}
          </button>
        </form>

        <!-- Empty folder or repository: create a vault. -->
        <form v-else-if="vault === 'empty'" class="stack" @submit.prevent="create">
          <p class="muted">
            This {{ git ? 'repository' : 'folder' }} has no vault yet. Create one with a master
            password.
          </p>
          <div v-if="git" class="notice notice-warn">
            <strong>Only do this on your first machine.</strong> On your other machines, select the
            same repository; they will find the existing vault.
          </div>
          <div v-else class="notice notice-warn">
            <strong>Only do this on your first machine.</strong> On your other machines, wait for
            Drive to finish syncing; they will find the existing vault.
          </div>
          <div class="field">
            <label for="new-password">Master password</label>
            <input
              id="new-password"
              ref="firstInput"
              v-model="password"
              class="input"
              type="password"
              autocomplete="off"
              spellcheck="false"
              :disabled="busy"
            />
          </div>
          <div class="field">
            <label for="confirm-password">Confirm password</label>
            <input
              id="confirm-password"
              v-model="confirmPassword"
              class="input"
              type="password"
              autocomplete="off"
              spellcheck="false"
              :disabled="busy"
            />
            <p v-if="password && createProblem" class="muted small">{{ createProblem }}</p>
          </div>
          <p class="muted small">
            There is no recovery: if you lose this password, the vault can't be opened. Keep it in
            your password manager.
          </p>
          <button type="submit" class="btn btn-primary" :disabled="busy || !canCreate">
            <span v-if="busy" class="spinner" />
            {{ busy ? 'Creating…' : 'Create vault' }}
          </button>
        </form>

        <!-- Folder or repository problems: never offer "create" here. -->
        <div v-else-if="vault === 'meta-missing'" class="stack">
          <div v-if="git" class="notice notice-error">
            <strong>The vault's meta.json is missing</strong>, but encrypted files are in the
            repository. If it was deleted, restore it from the repository's history (revert the
            commit that removed it). EnvVault won't create a new vault here, because that would
            orphan those files.
          </div>
          <div v-else class="notice notice-error">
            <strong>The vault's meta.json is missing</strong>, but encrypted files are present.
            Drive may still be syncing. If it was deleted, restore it from Drive's trash or version
            history. EnvVault won't create a new vault here, because that would orphan those files.
          </div>
          <button type="button" class="btn" @click="recheck">Check again</button>
        </div>
        <div v-else-if="vault === 'folder-missing'" class="stack">
          <div v-if="git" class="notice notice-error">
            <strong>Couldn't reach the vault repository.</strong> Check your network and your git
            access to it.
          </div>
          <div v-else class="notice notice-error">
            <strong>The vault folder was not found.</strong> Is Google Drive running and signed in?
          </div>
          <button type="button" class="btn" @click="recheck">Check again</button>
        </div>

        <p v-if="error" class="notice notice-error" role="alert">{{ error }}</p>

        <div class="row small">
          <span class="muted truncate grow" :title="vaultLabel(store.settings?.vault)">
            {{ vaultLabel(store.settings?.vault) }}
          </span>
          <button type="button" class="btn-link btn" @click="store.view = 'setup'">
            Folders and vault
          </button>
        </div>
      </div>
    </div>
  </main>
</template>
