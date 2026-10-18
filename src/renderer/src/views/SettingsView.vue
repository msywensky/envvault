<script setup lang="ts">
import { computed, ref } from 'vue'
import FolderField from '../components/FolderField.vue'
import { run, store, toast } from '../store'
import { machineNameProblem } from '../status'

const busy = ref(false)
const machineName = ref(store.settings?.machineName ?? '')
const nameProblem = computed(() => machineNameProblem(machineName.value))
const autoLockMinutes = ref(store.settings?.autoLockMinutes ?? 5)
const checkExample = ref(store.settings?.checkExample ?? true)
const autoPull = ref(store.settings?.autoPull ?? true)

async function pick(which: 'projects' | 'vault'): Promise<void> {
  busy.value = true
  // Choosing a different vault folder locks the app (the key belongs to the
  // old vault); main sends the lock event and the lock screen appears.
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
      autoPull: autoPull.value
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
        <FolderField
          label="Vault folder"
          :path="store.settings?.vaultPath ?? null"
          hint="Changing this locks EnvVault so you can unlock the other vault."
          :busy="busy"
          @pick="pick('vault')"
        />
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
