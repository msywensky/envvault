<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ArrowRight, RefreshCw, Settings2, ShieldCheck, Unlock } from 'lucide-vue-next'
import type { Result } from '../../../shared/result'
import { call, refreshState, store } from '../store'
import { vaultLabel } from '../vault'

const MIN_CHARS = 12

const password = ref('')
const confirmPassword = ref('')
const busy = ref(false)
const error = ref<string | null>(null)
const firstInput = ref<HTMLInputElement | null>(null)
const codeInput = ref<HTMLInputElement | null>(null)
// Setup codes are credentials: only ever in these local refs, never the
// store, and cleared once used, when the vault locks and when this screen
// goes away.
const requireCode = ref(true)
const typedCode = ref('')
const newCode = ref<string | null>(null)
const confirmGroup = ref('')

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
// This machine doesn't have the vault's secret yet: ask for the setup code too.
const needsCode = computed(() => vault.value === 'ready' && store.app?.setupCode === 'needed')
const lastGroup = computed(() => newCode.value?.split('-').at(-1) ?? '')
const confirmed = computed(
  () =>
    lastGroup.value !== '' &&
    confirmGroup.value.replace(/\s/g, '').toUpperCase() === lastGroup.value
)

/**
 * Send the password, clear the fields, and go to the repo list on success,
 * unless `after` says to stay (to show a new setup code).
 */
async function submit<T>(
  request: (password: string) => Promise<Result<T>>,
  after?: (data: T) => boolean
): Promise<void> {
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
  if (after && !after(res.data)) return
  await enter()
}

async function enter(): Promise<void> {
  typedCode.value = ''
  store.view = 'repos'
  await refreshState()
}

function unlock(): void {
  const code = needsCode.value ? typedCode.value.trim() : undefined
  if (!password.value || code === '') return
  void submit((pw) => window.envvault.unlock(pw, code))
}

function create(): void {
  if (!canCreate.value) return
  const withCode = git.value || requireCode.value
  void submit(
    (pw) => window.envvault.createVault(pw, withCode),
    (data) => {
      if (!data.setupCode) return true
      newCode.value = data.setupCode
      return false
    }
  )
}

/** The new setup code was saved: forget it here and go on. */
async function finishCreate(): Promise<void> {
  if (!confirmed.value) return
  newCode.value = null
  confirmGroup.value = ''
  await enter()
}

function onRequireCode(event: Event): void {
  requireCode.value = (event.target as HTMLInputElement).checked
}

async function recheck(): Promise<void> {
  error.value = null
  await refreshState()
}

// The autofocus attribute only works once per page load, and this screen is
// shown again after every lock, so focus explicitly.
async function focus(): Promise<void> {
  await nextTick()
  ;(needsCode.value && !typedCode.value ? codeInput.value : firstInput.value)?.focus()
}
onMounted(focus)
watch(vault, focus)
watch(needsCode, focus)
// Locked (idle, sleep) while a new code was showing: it's in Settings later.
watch(
  () => store.lockEpoch,
  () => {
    newCode.value = null
    confirmGroup.value = ''
    typedCode.value = ''
  }
)
onBeforeUnmount(() => {
  newCode.value = null
  typedCode.value = ''
})
</script>

<template>
  <main class="center-screen">
    <div class="panel card">
      <div class="card-body stack">
        <div class="panel-title">
          <span class="brand-mark" aria-hidden="true">E</span>
          <h1>EnvVault</h1>
        </div>

        <!-- Just created: the setup code, shown once. -->
        <form v-if="newCode" class="stack" @submit.prevent="finishCreate">
          <h2>Save your setup code</h2>
          <p class="muted">
            You'll need it, with your master password, to unlock this vault on another machine.
          </p>
          <div class="setup-code" tabindex="0" aria-label="Setup code">{{ newCode }}</div>
          <p class="muted small">
            Click it to select it, then copy it (⌘C or Ctrl+C) into your password manager, next to
            the master password.
          </p>
          <div class="notice notice-warn">
            <strong>Keep it safe.</strong> If you lose it and every machine that has it, the vault
            can't be opened, even with the password. You can show it again in Settings.
          </div>
          <div class="field">
            <label for="confirm-code">
              To continue, type its last group ({{ lastGroup.length }} characters)
            </label>
            <input
              id="confirm-code"
              v-model="confirmGroup"
              class="input input-narrow mono"
              maxlength="8"
              autocomplete="off"
              spellcheck="false"
            />
          </div>
          <button type="submit" class="btn btn-primary" :disabled="!confirmed">
            <ArrowRight />
            Continue
          </button>
        </form>

        <!-- Existing vault: unlock. -->
        <form v-else-if="vault === 'ready'" class="stack" @submit.prevent="unlock">
          <p class="muted">
            {{
              needsCode
                ? "Enter this vault's setup code and your master password to unlock it on this machine."
                : 'Enter your master password to unlock the vault.'
            }}
          </p>
          <div v-if="needsCode" class="field">
            <label for="setup-code">Setup code</label>
            <input
              id="setup-code"
              ref="codeInput"
              v-model="typedCode"
              class="input mono"
              placeholder="EV-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXX"
              maxlength="100"
              autocomplete="off"
              spellcheck="false"
              :disabled="busy"
            />
            <p class="muted small">
              This machine doesn't have this vault's setup code yet. Find it in Settings on a
              machine that's already set up, or in your password manager.
            </p>
          </div>
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
          <button
            type="submit"
            class="btn btn-primary"
            :disabled="busy || !password || (needsCode && !typedCode.trim())"
          >
            <span v-if="busy" class="spinner" />
            <Unlock v-else />
            {{ busy ? 'Unlocking.' : 'Unlock' }}
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
          <div class="field">
            <label class="checkbox">
              <input
                type="checkbox"
                :checked="git || requireCode"
                :disabled="busy || git"
                @change="onRequireCode"
              />
              <span>Require a setup code on every machine (recommended)</span>
            </label>
            <p v-if="git" class="muted small">
              Always on for a git vault: anyone who can read the repository or its history could
              otherwise try to guess the master password.
            </p>
            <p v-else class="muted small">
              A copy of the vault folder is then no use for guessing the master password. Each new
              machine needs the code once.
            </p>
          </div>
          <p class="muted small">
            EnvVault refuses passwords that are easy to guess: use several random words, or let your
            password manager generate one. There is no recovery: if you lose this password, the
            vault can't be opened. Keep it in your password manager.
          </p>
          <button type="submit" class="btn btn-primary" :disabled="busy || !canCreate">
            <span v-if="busy" class="spinner" />
            <ShieldCheck v-else />
            {{ busy ? 'Creating.' : 'Create vault' }}
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
          <button type="button" class="btn" @click="recheck">
            <RefreshCw />
            Check again
          </button>
        </div>
        <div v-else-if="vault === 'folder-missing'" class="stack">
          <div v-if="git" class="notice notice-error">
            <strong>Couldn't reach the vault repository.</strong> Check your network and your git
            access to it.
          </div>
          <div v-else class="notice notice-error">
            <strong>The vault folder was not found.</strong> Is Google Drive running and signed in?
          </div>
          <button type="button" class="btn" @click="recheck">
            <RefreshCw />
            Check again
          </button>
        </div>

        <p v-if="error" class="notice notice-error" role="alert">{{ error }}</p>

        <div class="row small">
          <span class="muted truncate grow" :title="vaultLabel(store.settings?.vault)">
            {{ vaultLabel(store.settings?.vault) }}
          </span>
          <button type="button" class="btn-link btn" @click="store.view = 'setup'">
            <Settings2 />
            Folders and vault
          </button>
        </div>
      </div>
    </div>
  </main>
</template>
