<script setup lang="ts">
// Settings' Sync tab. The env file rules every repo without its own uses are
// kept in the vault, for every machine (patterns only, no values); the rest
// is this machine's. Save saves whichever of the two changed.
import { computed, onMounted, ref, watch } from 'vue'
import { RESERVED_NOTE, type FileRules } from '../../../shared/envrules'
import { call, loadRepos, saveSettings, store, toast, unsavedSettings } from '../store'
import { patternLines, patternListProblems } from '../status'
import PatternList from './PatternList.vue'
import SaveBar from './SaveBar.vue'

const emit = defineEmits<{ unsaved: [on: boolean] }>()

const busy = ref(false)

// ---- the defaults, in the vault

const saved = computed(() => store.repoSettings?.defaults ?? { include: ['.env'], exclude: [] })
const settingsError = computed(() => store.repoSettings?.error ?? null)
// Not until the list has read them, and not while they can't be read.
const rulesReadOnly = computed(() => busy.value || !store.reposLoaded || !!settingsError.value)
const includeText = ref('')
const excludeText = ref('')
const rulesError = ref<string | null>(null)
const confirmingReset = ref(false)

function setRules(rules: FileRules): void {
  includeText.value = rules.include.join('\n')
  excludeText.value = rules.exclude.join('\n')
}
setRules(saved.value)

const rules = computed(() => ({
  include: patternLines(includeText.value),
  exclude: patternLines(excludeText.value)
}))
const sameRules = (a: FileRules, b: FileRules): boolean =>
  a.include.join('\n') === b.include.join('\n') && a.exclude.join('\n') === b.exclude.join('\n')
const rulesUnsaved = computed(() => !sameRules(rules.value, saved.value))
const problems = computed(() => [
  ...patternListProblems(includeText.value),
  ...patternListProblems(excludeText.value)
])

// The vault's copy changed (read for the first time, or by another machine):
// follow it unless they've been edited here.
watch(saved, (next, prev) => {
  if (sameRules(rules.value, prev)) setRules(next)
})

// Repos that use at least one of the default lists.
const using = computed(() => {
  const own = store.repoSettings?.repos ?? {}
  return store.repoInfo.filter((r) => {
    const mine = own[r.vaultName.toLowerCase()]
    return !mine || mine.include === null || mine.exclude === null
  }).length
})

async function resetSettings(): Promise<void> {
  if (busy.value) return
  busy.value = true
  const res = await call(() => window.envvault.resetSettings())
  busy.value = false
  confirmingReset.value = false
  if (res.ok) {
    toast('success', 'Reset the repo settings.')
    await loadRepos()
  } else if (res.error.code !== 'LOCKED') {
    toast('error', res.error.message)
  }
}

// Opened before Repositories read the list.
onMounted(() => {
  if (!store.reposLoaded) void loadRepos()
})

// ---- this machine's

const checkExample = ref(true)
const autoPull = ref(false)
const backups = ref(true)
const backupCount = ref(3)

function loadMachine(): void {
  const s = store.settings
  checkExample.value = s?.checkExample ?? true
  autoPull.value = s?.autoPull ?? false
  backups.value = s?.backups ?? true
  backupCount.value = s?.backupCount ?? 3
}
loadMachine()

const machine = computed(() => ({
  checkExample: checkExample.value,
  autoPull: autoPull.value,
  backups: backups.value,
  backupCount: Number(backupCount.value)
}))
const machineUnsaved = computed(() => unsavedSettings(machine.value))

// ---- both

const unsaved = computed(() => rulesUnsaved.value || machineUnsaved.value)
const invalid = computed(() => rulesUnsaved.value && problems.value.length > 0)
watch(unsaved, (on) => emit('unsaved', on), { immediate: true })

async function save(): Promise<void> {
  if (busy.value || !unsaved.value || invalid.value) return
  busy.value = true
  rulesError.value = null
  let ok = true
  if (machineUnsaved.value) {
    if (await saveSettings(machine.value)) loadMachine()
    else ok = false
  }
  if (rulesUnsaved.value) {
    // Plain values only: IPC can't clone reactive ones.
    const next = { include: [...rules.value.include], exclude: [...rules.value.exclude] }
    const res = await call(() => window.envvault.saveDefaults(next))
    if (res.ok) {
      setRules(next)
      await loadRepos()
    } else {
      ok = false
      if (res.error.code !== 'LOCKED') rulesError.value = res.error.message
    }
  }
  busy.value = false
  if (ok) toast('success', 'Settings saved.')
}
</script>

<template>
  <form class="stack" @submit.prevent="save">
    <SaveBar :busy="busy" :unsaved="unsaved" :invalid="invalid" />
    <div class="card">
      <div class="card-body stack">
        <div>
          <h2>Env files every repo syncs</h2>
          <p class="muted small">
            Kept in the vault: repos without their own lists use these, on every machine.
            <template v-if="store.reposLoaded">
              {{ using }} {{ using === 1 ? 'repo does' : 'repos do' }} now.
            </template>
          </p>
        </div>
        <div v-if="settingsError" class="notice notice-error stack" role="alert">
          <span>{{ settingsError.message }}</span>
          <div v-if="settingsError.code === 'VAULT_TAMPERED'" class="row">
            <template v-if="confirmingReset">
              <span class="grow">
                Replace them with empty settings on every machine? Every repo then syncs its .env
                files only, and none is ignored.
              </span>
              <button type="button" class="btn btn-sm" @click="confirmingReset = false">
                Cancel
              </button>
              <button
                type="button"
                class="btn btn-sm btn-danger"
                :disabled="busy"
                @click="resetSettings"
              >
                Reset
              </button>
            </template>
            <button v-else type="button" class="btn btn-sm" @click="confirmingReset = true">
              Reset settings…
            </button>
          </div>
        </div>
        <PatternList
          id="defaults-include"
          v-model:text="includeText"
          label="Env files to sync"
          hint="One per line. A name matches in every folder (.env, .env.local, .env.*); a path is from the repo root (apps/*/.env.local)."
          :disabled="rulesReadOnly"
        />
        <PatternList
          id="defaults-exclude"
          v-model:text="excludeText"
          label="Env files not to sync"
          hint="Wins over the list above. A folder covers everything in it (apps/legacy, **/fixtures)."
          :disabled="rulesReadOnly"
        />
        <p class="muted small">{{ RESERVED_NOTE }}</p>
        <p class="muted small">
          Variants such as .env.local often hold values that differ from machine to machine. Sync
          them only where they don't, or mark those keys with # envvault:local.
        </p>
        <p v-if="rulesError" class="notice notice-error" role="alert">{{ rulesError }}</p>
      </div>
    </div>
    <div class="card">
      <div class="card-body stack">
        <h2>On this machine</h2>
        <div class="field">
          <label class="checkbox">
            <input v-model="checkExample" type="checkbox" />
            <span>Compare .env with .env.example before a push or pull</span>
          </label>
          <p class="muted small">
            Warns about missing keys and secret-looking values copied into .env.example. Never
            blocks.
          </p>
        </div>
        <div class="field">
          <label class="checkbox">
            <input v-model="autoPull" type="checkbox" />
            <span>Pull automatically when another machine updates an env file</span>
          </label>
          <p class="muted small">
            While unlocked, for files that haven't changed here since the last sync (a missing one
            is created); conflicts are left for you. Off by default: with it on, a push from any of
            your machines reaches this one without review.
          </p>
        </div>
        <div class="field">
          <label class="checkbox">
            <input v-model="backups" type="checkbox" />
            <span>Back up an env file before a pull replaces it</span>
          </label>
          <p class="muted small">
            Saved next to it as .env.bak.&lt;timestamp&gt; (.env.bak.local.&lt;timestamp&gt; for
            .env.local), in plaintext like the file itself. Git ignores them, but other tools may
            not: add .env.bak.* to a .dockerignore too.
          </p>
        </div>
        <div v-if="backups" class="field">
          <label for="settings-backups">Backups to keep per env file</label>
          <input
            id="settings-backups"
            v-model.number="backupCount"
            class="input input-narrow"
            type="number"
            min="1"
            max="50"
            required
          />
          <p class="muted small">Older ones are deleted when a pull saves a new one.</p>
        </div>
      </div>
    </div>
    <SaveBar :busy="busy" :unsaved="unsaved" :invalid="invalid" />
  </form>
</template>
