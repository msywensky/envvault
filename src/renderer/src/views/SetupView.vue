<script setup lang="ts">
// First run (and "Folders and vault" from the lock screen or Settings).
// Folder paths are chosen with the native picker in main; the renderer never
// sends paths. A git vault is chosen by URL, which main checks (see
// GitVaultField).
import { computed, ref } from 'vue'
import type { Settings } from '../../../shared/types'
import FolderField from '../components/FolderField.vue'
import GitVaultField from '../components/GitVaultField.vue'
import { refreshState, run, store, toast } from '../store'
import { machineNameProblem } from '../status'

const busy = ref(false)
const machineName = ref(store.settings?.machineName ?? '')
const nameProblem = computed(() => machineNameProblem(machineName.value))

const ready = computed(() => Boolean(store.settings?.projectsPath && store.settings.vault))
const wasConfigured = computed(() => store.app?.configured ?? false)
const vaultKind = ref<'folder' | 'git'>(store.settings?.vault?.kind ?? 'folder')

function savedVault(next: Settings): void {
  store.settings = next
}

async function pick(which: 'projects' | 'vault'): Promise<void> {
  busy.value = true
  const next = await run(() => window.envvault.pickFolder(which))
  busy.value = false
  if (next) store.settings = next
}

async function done(): Promise<void> {
  if (!store.settings) return
  busy.value = true
  const patch = {
    autoLock: store.settings.autoLock,
    autoLockMinutes: store.settings.autoLockMinutes,
    machineName: machineName.value,
    checkExample: store.settings.checkExample,
    autoPull: store.settings.autoPull,
    cliAccess: store.settings.cliAccess
  }
  const saved = await run(() => window.envvault.saveSettings(patch))
  busy.value = false
  if (!saved) return
  const firstRun = !wasConfigured.value
  store.settings = saved
  await back()
  if (firstRun) toast('success', 'Setup saved.')
}

async function back(): Promise<void> {
  store.view = 'lock'
  await refreshState()
}
</script>

<template>
  <main class="center-screen">
    <div class="panel panel-wide card">
      <form class="card-body stack" @submit.prevent="done">
        <div>
          <div class="panel-title">
            <span class="brand-mark" aria-hidden="true">E</span>
            <h1>{{ wasConfigured ? 'Folders and vault' : 'Set up EnvVault' }}</h1>
          </div>
          <p class="muted">
            EnvVault syncs each repo's <code>.env</code> through an encrypted vault: a folder synced
            between your machines, or a private git repository.
          </p>
        </div>

        <FolderField
          label="Projects folder"
          :path="store.settings?.projectsPath ?? null"
          hint="The folder that contains your git repositories (one level deep)."
          :busy="busy"
          @pick="pick('projects')"
        />
        <fieldset class="field">
          <legend>Vault</legend>
          <div class="choice">
            <label
              class="choice-option"
              :class="{ 'choice-option-active': vaultKind === 'folder' }"
            >
              <input v-model="vaultKind" type="radio" name="vault-kind" value="folder" />
              <span class="choice-text">
                <strong>A synced folder</strong>
                <span class="muted small">Google Drive, Dropbox, iCloud…</span>
              </span>
            </label>
            <label class="choice-option" :class="{ 'choice-option-active': vaultKind === 'git' }">
              <input v-model="vaultKind" type="radio" name="vault-kind" value="git" />
              <span class="choice-text">
                <strong>A private git repository</strong>
                <span class="muted small">GitHub, GitLab…</span>
              </span>
            </label>
          </div>
        </fieldset>
        <FolderField
          v-if="vaultKind === 'folder'"
          label="Vault folder"
          :path="store.settings?.vault?.kind === 'folder' ? store.settings.vault.path : null"
          hint="A folder synced between your machines, e.g. My Drive/EnvVault. It only ever holds encrypted files."
          :busy="busy"
          @pick="pick('vault')"
        />
        <GitVaultField v-else :busy="busy" @saved="savedVault" />
        <div class="field">
          <label for="machine-name">This machine's name</label>
          <input
            id="machine-name"
            v-model="machineName"
            class="input"
            maxlength="64"
            required
            autocomplete="off"
            spellcheck="false"
          />
          <p v-if="nameProblem" class="muted small">{{ nameProblem }}</p>
          <p v-else class="muted small">Shown to your other machines as "updated by".</p>
        </div>

        <div class="row">
          <button v-if="wasConfigured" type="button" class="btn" :disabled="busy" @click="back">
            Back
          </button>
          <span class="grow" />
          <button type="submit" class="btn btn-primary" :disabled="!ready || busy || !!nameProblem">
            Continue
          </button>
        </div>
      </form>
    </div>
  </main>
</template>
