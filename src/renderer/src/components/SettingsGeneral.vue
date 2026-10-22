<script setup lang="ts">
// Settings' General tab: this machine, and the vault and how it locks. The
// projects folder is saved as soon as it's chosen, and the vault is changed
// in Setup; the rest waits for Save.
import { computed, ref, watch } from 'vue'
import { run, saveSettings, store, toast, unsavedSettings } from '../store'
import { machineNameProblem } from '../status'
import { vaultKindLabel, vaultLabel } from '../vault'
import FolderField from './FolderField.vue'
import SaveBar from './SaveBar.vue'
import SetupCodeField from './SetupCodeField.vue'

const emit = defineEmits<{ unsaved: [on: boolean] }>()

const busy = ref(false)
const machineName = ref('')
const autoLock = ref(true)
const autoLockMinutes = ref(5)
const miniOnTop = ref(true)
// Turning auto-lock off waits for the warning to be confirmed; turning it on doesn't.
const confirmingAutoLockOff = ref(false)

function load(): void {
  const s = store.settings
  machineName.value = s?.machineName ?? ''
  autoLock.value = s?.autoLock ?? true
  autoLockMinutes.value = s?.autoLockMinutes ?? 5
  miniOnTop.value = s?.miniOnTop ?? true
}
load()

const nameProblem = computed(() => machineNameProblem(machineName.value))
const draft = computed(() => ({
  machineName: machineName.value,
  autoLock: autoLock.value,
  autoLockMinutes: Number(autoLockMinutes.value),
  miniOnTop: miniOnTop.value
}))
const unsaved = computed(() => unsavedSettings(draft.value))
watch(unsaved, (on) => emit('unsaved', on), { immediate: true })

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
  if (busy.value || !unsaved.value || nameProblem.value) return
  busy.value = true
  const saved = await saveSettings(draft.value)
  busy.value = false
  if (saved) {
    // Main trims the name: show what it kept.
    load()
    toast('success', 'Settings saved.')
  }
}
</script>

<template>
  <form class="stack" @submit.prevent="save">
    <SaveBar :busy="busy" :unsaved="unsaved" :invalid="!!nameProblem" />
    <div class="card">
      <div class="card-body stack">
        <h2>This machine</h2>
        <div class="field">
          <label for="settings-machine">Name</label>
          <input
            id="settings-machine"
            v-model="machineName"
            class="input"
            maxlength="64"
            required
            autocomplete="off"
            spellcheck="false"
            :aria-invalid="!!nameProblem"
            aria-describedby="settings-machine-help"
          />
          <p id="settings-machine-help" :class="nameProblem ? 'field-error small' : 'muted small'">
            {{ nameProblem ?? 'Other machines see it as "updated by".' }}
          </p>
        </div>
        <FolderField
          label="Projects folder"
          :path="store.settings?.projectsPath ?? null"
          :busy="busy"
          @pick="pick('projects')"
        />
        <div class="field">
          <label class="checkbox">
            <input v-model="miniOnTop" type="checkbox" />
            <span>Keep the mini window on top</span>
          </label>
          <p class="muted small">
            Click Mini next to an env file to show just that file, with its Push button, in a small
            window above your other windows.
          </p>
        </div>
      </div>
    </div>
    <div class="card">
      <div class="card-body stack">
        <h2>Vault</h2>
        <!-- Changing it is done in Setup, which offers both kinds of vault. -->
        <div class="field">
          <label>Location</label>
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
      </div>
    </div>
    <SaveBar :busy="busy" :unsaved="unsaved" :invalid="!!nameProblem" />
  </form>
</template>
