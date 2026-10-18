<script setup lang="ts">
// First run (and "Change folders" from the lock screen). Folder paths are
// chosen with the native picker in main; the renderer never sends paths.
import { computed, ref } from 'vue'
import FolderField from '../components/FolderField.vue'
import { refreshState, run, store, toast } from '../store'
import { machineNameProblem } from '../status'

const busy = ref(false)
const machineName = ref(store.settings?.machineName ?? '')
const nameProblem = computed(() => machineNameProblem(machineName.value))

const ready = computed(() => Boolean(store.settings?.projectsPath && store.settings.vaultPath))
const wasConfigured = computed(() => store.app?.configured ?? false)

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
  if (firstRun) toast('success', 'Folders saved.')
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
            <h1>{{ wasConfigured ? 'Folders' : 'Set up EnvVault' }}</h1>
          </div>
          <p class="muted">
            EnvVault syncs each repo's <code>.env</code> through an encrypted vault folder, such as
            a folder in Google Drive.
          </p>
        </div>

        <FolderField
          label="Projects folder"
          :path="store.settings?.projectsPath ?? null"
          hint="The folder that contains your git repositories (one level deep)."
          :busy="busy"
          @pick="pick('projects')"
        />
        <FolderField
          label="Vault folder"
          :path="store.settings?.vaultPath ?? null"
          hint="A folder synced between your machines, e.g. My Drive/EnvVault. It only ever holds encrypted files."
          :busy="busy"
          @pick="pick('vault')"
        />
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
