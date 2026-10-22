<script setup lang="ts">
// A repo's settings. Which name it syncs as is this machine's alone; whether
// it's ignored and which env files it syncs are kept in the vault, by that
// name, for every machine. Patterns and names only: no values here.
import { computed, onMounted, ref, watch } from 'vue'
import { Check } from 'lucide-vue-next'
import { RESERVED_NOTE, isIncluded } from '../../../shared/envrules'
import type { RepoInfo, RepoRules } from '../../../shared/types'
import { call, loadRepos, store, toast } from '../store'
import { patternLines, patternListProblems, repoKey, repoNameProblem, syncsAs } from '../status'
import PatternList from './PatternList.vue'

const props = defineProps<{ repo: RepoInfo }>()
const emit = defineEmits<{ close: [] }>()

const dialog = ref<HTMLDialogElement | null>(null)
const busy = ref(false)
const error = ref<string | null>(null)

// The repo as of the latest list: Apply below changes its vault name.
const info = computed(
  () => store.repoInfo.find((r) => repoKey(r) === repoKey(props.repo)) ?? props.repo
)
const vaultId = computed(() => info.value.vaultName.toLowerCase())
const defaults = computed(() => store.repoSettings?.defaults ?? { include: ['.env'], exclude: [] })
const saved = computed(
  (): RepoRules =>
    store.repoSettings?.repos[vaultId.value] ?? { ignored: false, include: null, exclude: null }
)
const unreadable = computed(() => store.repoSettings?.error ?? null)

// ---- sync as (this machine) ----

const vaultName = ref(info.value.vaultName)
const nameProblem = computed(() => repoNameProblem(vaultName.value.trim()))
const nameChanged = computed(() => vaultName.value.trim() !== info.value.vaultName)

async function applyName(): Promise<void> {
  if (busy.value || nameProblem.value || !nameChanged.value) return
  busy.value = true
  error.value = null
  const request = { repoName: info.value.name, vaultName: vaultName.value.trim() }
  const res = await call(() => window.envvault.setVaultName(request))
  if (res.ok) await loadRepos()
  else if (res.error.code !== 'LOCKED') error.value = res.error.message
  busy.value = false
}

// ---- every machine ----

const ignored = ref(false)
const includeText = ref('')
const excludeText = ref('')
const includeDefaults = ref(true)
const excludeDefaults = ref(true)

/** Start again from what the vault has for the repo's current vault name. */
function reset(): void {
  const rules = saved.value
  ignored.value = rules.ignored
  includeDefaults.value = rules.include === null
  excludeDefaults.value = rules.exclude === null
  includeText.value = (rules.include ?? []).join('\n')
  excludeText.value = (rules.exclude ?? []).join('\n')
}
reset()
// Another vault name has its own settings.
watch(vaultId, reset)

const draft = computed((): RepoRules => ({
  ignored: ignored.value,
  include: includeDefaults.value ? null : patternLines(includeText.value),
  exclude: excludeDefaults.value ? null : patternLines(excludeText.value)
}))
const problems = computed(() => [
  ...(includeDefaults.value ? [] : patternListProblems(includeText.value)),
  ...(excludeDefaults.value ? [] : patternListProblems(excludeText.value))
])
const sameList = (a: string[] | null, b: string[] | null): boolean =>
  a === null || b === null ? a === b : a.join('\n') === b.join('\n')
const dirty = computed(
  () =>
    draft.value.ignored !== saved.value.ignored ||
    !sameList(draft.value.include, saved.value.include) ||
    !sameList(draft.value.exclude, saved.value.exclude)
)

// What the draft would sync, from the files found at the last Refresh and the vault copies.
const vaultPaths = computed(() =>
  store.repos
    .filter((r) => repoKey(r) === repoKey(info.value) && r.storedName && r.path !== null)
    .map((r) => r.path as string)
)
const preview = computed(() => {
  const rules = {
    include: draft.value.include ?? defaults.value.include,
    exclude: draft.value.exclude ?? defaults.value.exclude
  }
  const known = [...new Set([...(info.value.found ?? []), ...vaultPaths.value])].sort()
  return {
    syncs: known.filter((p) => isIncluded(p, rules)),
    dropped: vaultPaths.value.filter((p) => !isIncluded(p, rules))
  }
})

async function save(): Promise<void> {
  if (busy.value || problems.value.length || !dirty.value) return
  busy.value = true
  error.value = null
  // Plain values only: IPC can't clone reactive ones.
  const request = {
    vaultName: info.value.vaultName,
    ignored: draft.value.ignored,
    include: draft.value.include ? [...draft.value.include] : null,
    exclude: draft.value.exclude ? [...draft.value.exclude] : null
  }
  // An ignored repo was never scanned: ask git about it once it isn't.
  const rescan = saved.value.ignored && !request.ignored
  const res = await call(() => window.envvault.saveRepoSettings(request))
  busy.value = false
  if (res.ok) {
    toast('success', `Saved the settings of ${info.value.name}.`)
    await loadRepos(rescan)
    emit('close')
  } else if (res.error.code !== 'LOCKED') {
    error.value = res.error.message
  }
}

onMounted(() => dialog.value?.showModal())

// Close if the session locks while the dialog is open.
watch(
  () => store.lockEpoch,
  () => emit('close')
)
</script>

<template>
  <dialog
    ref="dialog"
    class="dialog dialog-wide"
    aria-labelledby="repo-settings-title"
    @cancel.prevent="emit('close')"
  >
    <div class="dialog-header">
      <h2 id="repo-settings-title">Settings: {{ info.name }}</h2>
      <p class="muted small">
        {{ info.local ? 'In your projects folder.' : 'Only in the vault.' }}
        <template v-if="syncsAs(info)">
          Syncs as <code>{{ info.vaultName }}</code> on this machine.
        </template>
      </p>
    </div>

    <div class="dialog-body repo-settings">
      <section v-if="info.local" class="stack">
        <h3>On this machine</h3>
        <div class="field">
          <label for="repo-vault-name">Sync as</label>
          <div class="row">
            <input
              id="repo-vault-name"
              v-model="vaultName"
              class="input grow"
              maxlength="100"
              spellcheck="false"
              autocomplete="off"
              autocapitalize="off"
              :disabled="busy"
              @keydown.enter.prevent="applyName"
            />
            <button
              type="button"
              class="btn"
              :disabled="busy || !nameChanged || !!nameProblem"
              @click="applyName"
            >
              Apply
            </button>
          </div>
          <p v-if="nameChanged && nameProblem" class="small editor-problem">{{ nameProblem }}</p>
          <p class="muted small">
            The name this folder's env files have in the vault: its own, or another repo's, for a
            second checkout, a git worktree or a renamed folder. Use the repo's name on your other
            machines. Only this machine is changed.
          </p>
        </div>
      </section>

      <section class="stack">
        <h3>
          On every machine
          <span class="muted small"
            >(for <code>{{ info.vaultName }}</code
            >)</span
          >
        </h3>
        <p v-if="unreadable" class="notice notice-error" role="alert">{{ unreadable.message }}</p>
        <div class="field">
          <label class="checkbox">
            <input v-model="ignored" type="checkbox" :disabled="busy || !!unreadable" />
            <span>Ignore this repo</span>
          </label>
          <p class="muted small">
            EnvVault won't read its env files, push them or pull into it, on any machine.
            <template v-if="info.copies">
              Its {{ info.copies }} vault {{ info.copies === 1 ? 'copy stays' : 'copies stay' }} in
              the vault.
            </template>
          </p>
        </div>
        <template v-if="!ignored">
          <PatternList
            id="repo-include"
            v-model:text="includeText"
            v-model:use-defaults="includeDefaults"
            label="Env files to sync"
            hint="One per line. A name matches in every folder (.env.local, .env.*); a path is from the repo root (apps/*/.env.local)."
            :defaults="defaults.include"
            :disabled="busy || !!unreadable"
          />
          <PatternList
            id="repo-exclude"
            v-model:text="excludeText"
            v-model:use-defaults="excludeDefaults"
            label="Env files not to sync"
            hint="Wins over the list above. A folder covers everything in it (apps/legacy, **/fixtures)."
            :defaults="defaults.exclude"
            :disabled="busy || !!unreadable"
          />
          <p class="muted small">{{ RESERVED_NOTE }}</p>
          <div v-if="!problems.length" class="notice notice-info stack">
            <template v-if="info.found !== null || vaultPaths.length">
              <div class="pattern-preview">
                <span>Syncs:</span>
                <code v-for="p in preview.syncs" :key="p" class="chip chip-kept">{{ p }}</code>
                <span v-if="!preview.syncs.length">nothing</span>
              </div>
              <div v-if="preview.dropped.length" class="pattern-preview">
                <span>Vault copies it would exclude, to remove:</span>
                <code v-for="p in preview.dropped" :key="p" class="chip chip-removed">{{ p }}</code>
              </div>
              <span class="small">From the files found at the last Refresh.</span>
            </template>
            <span v-else>Refresh the list to see which files these match.</span>
          </div>
        </template>
      </section>

      <p v-if="error" class="notice notice-error" role="alert">{{ error }}</p>
    </div>

    <div class="dialog-footer">
      <button type="button" class="btn" :disabled="busy" @click="emit('close')">Cancel</button>
      <button
        type="button"
        class="btn btn-primary"
        :disabled="busy || !dirty || problems.length > 0 || !!unreadable"
        @click="save"
      >
        <span v-if="busy" class="spinner" />
        <Check v-else />
        Save
      </button>
    </div>
  </dialog>
</template>
