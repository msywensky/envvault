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
const autoLock = ref(store.settings?.autoLock ?? true)
const autoLockMinutes = ref(store.settings?.autoLockMinutes ?? 5)
// Turning auto-lock off waits for the warning to be confirmed; turning it on doesn't.
const confirmingAutoLockOff = ref(false)
const checkExample = ref(store.settings?.checkExample ?? true)
const autoPull = ref(store.settings?.autoPull ?? true)
const cliAccess = ref(store.settings?.cliAccess ?? false)
const miniOnTop = ref(store.settings?.miniOnTop ?? true)

async function pick(which: 'projects'): Promise<void> {
  busy.value = true
  const next = await run(() => window.envvault.pickFolder(which))
  busy.value = false
  if (next) {
    store.settings = next
    toast('success', 'Folder saved.')
  }
}

function changeAutoLock(event: Event): void {
  const input = event.target as HTMLInputElement
  if (input.checked) {
    autoLock.value = true
    confirmingAutoLockOff.value = false
    return
  }
  input.checked = true
  confirmingAutoLockOff.value = true
}

function turnOffAutoLock(): void {
  autoLock.value = false
  confirmingAutoLockOff.value = false
}

async function save(): Promise<void> {
  busy.value = true
  const saved = await run(() =>
    window.envvault.saveSettings({
      autoLock: autoLock.value,
      autoLockMinutes: Number(autoLockMinutes.value),
      machineName: machineName.value,
      checkExample: checkExample.value,
      autoPull: autoPull.value,
      cliAccess: cliAccess.value,
      miniOnTop: miniOnTop.value
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
          <label class="checkbox">
            <input :checked="autoLock" type="checkbox" @change="changeAutoLock" />
            <span>Lock automatically when idle</span>
          </label>
          <div v-if="confirmingAutoLockOff" class="notice notice-warn stack" role="alert">
            <p>
              <strong>Turn off auto-lock?</strong> EnvVault will stay unlocked until you click Lock,
              close its window, or the computer sleeps or locks its screen. Meanwhile anyone at this
              computer can push, pull and show .env values without the password.
            </p>
            <div class="row">
              <span class="grow" />
              <button type="button" class="btn btn-sm" @click="confirmingAutoLockOff = false">
                Keep it on
              </button>
              <button type="button" class="btn btn-sm btn-danger" @click="turnOffAutoLock">
                Turn off
              </button>
            </div>
          </div>
          <p v-else-if="!autoLock" class="muted small">
            EnvVault stays unlocked until you click Lock, close its window, or the computer sleeps
            or locks its screen.
          </p>
        </div>
        <div v-if="autoLock" class="field">
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
            <input v-model="miniOnTop" type="checkbox" />
            <span>Keep the mini window on top</span>
          </label>
          <p class="muted small">
            Click Mini next to a repo to show just that repo, with its Push button, in a small
            window above your other windows.
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
