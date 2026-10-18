<script setup lang="ts">
import { computed, ref } from 'vue'
import FolderField from '../components/FolderField.vue'
import SetupCodeField from '../components/SetupCodeField.vue'
import SkillField from '../components/SkillField.vue'
import { run, store, toast } from '../store'
import { machineNameProblem } from '../status'
import { vaultKindLabel, vaultLabel } from '../vault'

const busy = ref(false)
const machineName = ref(store.settings?.machineName ?? '')
const nameProblem = computed(() => machineNameProblem(machineName.value))
const autoLockMinutes = ref(store.settings?.autoLockMinutes ?? 5)
const checkExample = ref(store.settings?.checkExample ?? true)
const autoPull = ref(store.settings?.autoPull ?? true)
const cliAccess = ref(store.settings?.cliAccess ?? false)

async function pick(which: 'projects'): Promise<void> {
  busy.value = true
  const next = await run(() => window.envvault.pickFolder(which))
  busy.value = false
  if (next) {
    store.settings = next
    toast('success', 'Folder saved.')
  }
}

async function save(): Promise<void> {
  busy.value = true
  const saved = await run(() =>
    window.envvault.saveSettings({
      autoLockMinutes: Number(autoLockMinutes.value),
      machineName: machineName.value,
      checkExample: checkExample.value,
      autoPull: autoPull.value,
      cliAccess: cliAccess.value
    })
  )
  busy.value = false
  if (saved) {
    store.settings = saved
    toast('success', 'Settings saved.')
  }
}
</script>

<template>
  <div class="page">
    <div class="page-header">
      <h1 class="grow">Settings</h1>
    </div>
    <div class="card">
      <form class="card-body stack" @submit.prevent="save">
        <FolderField
          label="Projects folder"
          :path="store.settings?.projectsPath ?? null"
          :busy="busy"
          @pick="pick('projects')"
        />
        <!-- Changing it is done in Setup, which offers both kinds of vault. -->
        <div class="field">
          <label>Vault</label>
          <div class="folder">
            <span class="vault-kind">{{ vaultKindLabel(store.settings?.vault) }}</span>
            <span class="folder-path" :title="vaultLabel(store.settings?.vault)">
              {{ vaultLabel(store.settings?.vault) }}
            </span>
            <button type="button" class="btn btn-sm" :disabled="busy" @click="store.view = 'setup'">
              Change…
            </button>
          </div>
          <p class="muted small">Changing it locks EnvVault so you can unlock the other vault.</p>
        </div>
        <SetupCodeField />
        <div class="field">
          <label for="settings-machine">This machine's name</label>
          <input
            id="settings-machine"
            v-model="machineName"
            class="input"
            maxlength="64"
            required
            autocomplete="off"
            spellcheck="false"
          />
          <p v-if="nameProblem" class="muted small">{{ nameProblem }}</p>
        </div>
        <div class="field">
          <label for="settings-autolock">Auto-lock after (minutes idle)</label>
          <input
            id="settings-autolock"
            v-model.number="autoLockMinutes"
            class="input input-narrow"
            type="number"
            min="1"
            max="120"
            required
          />
        </div>
        <div class="field">
          <label class="checkbox">
            <input v-model="checkExample" type="checkbox" />
            <span>Compare with .env.example before a push or pull</span>
          </label>
          <p class="muted small">
            Warns about missing keys and secret-looking values copied into .env.example. Never
            blocks.
          </p>
        </div>
        <div class="field">
          <label class="checkbox">
            <input v-model="autoPull" type="checkbox" />
            <span>Pull automatically when another machine updates a .env</span>
          </label>
          <p class="muted small">
            While EnvVault is unlocked. Only when your local .env hasn't changed since the last
            sync; conflicts are left for you. Creates a missing .env, and saves a backup first.
          </p>
        </div>
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
        <div class="row">
          <span class="grow" />
          <button type="submit" class="btn btn-primary" :disabled="busy || !!nameProblem">
            Save
          </button>
        </div>
      </form>
    </div>
  </div>
</template>
