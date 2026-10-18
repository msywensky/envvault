<script setup lang="ts">
// Edits the vault copy as a key/value table. Unlike the rest of the UI this
// holds env values: they arrive from repo:openEditor, live only in `rows`
// (never the store), are masked until shown, are masked again when the window
// is hidden or after a minute without input, and are dropped when the dialog
// closes or the app locks. Only changed values go back, via repo:saveEdit.
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { RepoRow } from '../../../shared/types'
import { envKeyProblem } from '../status'
import { call, store, toast } from '../store'

const props = defineProps<{ repo: RepoRow }>()
const emit = defineEmits<{ close: []; done: [] }>()

interface Row {
  /** Stable v-for key. */
  id: number
  key: string
  /** The value as loaded, or null for a row added here. */
  original: string | null
  value: string
  marked: boolean
  removed: boolean
  revealed: boolean
}

const MASK = '••••••••'
const IDLE_MS = 60_000

const dialog = ref<HTMLDialogElement | null>(null)
const phase = ref<'loading' | 'failed' | 'edit' | 'review' | 'saving'>('loading')
const rows = ref<Row[]>([])
const error = ref<string | null>(null)
const conflict = ref(false)
const confirmDiscard = ref(false)
// A plain string, captured at load: it goes back to main with the save.
let expectedVaultHash: string | null = null
let nextId = 0
let idleTimer: ReturnType<typeof setTimeout> | null = null

const isChanged = (r: Row): boolean =>
  r.original !== null && !r.removed && !r.marked && r.value !== r.original
const added = computed(() => rows.value.filter((r) => r.original === null))
const changed = computed(() => rows.value.filter(isChanged))
const removed = computed(() => rows.value.filter((r) => r.original !== null && r.removed))
const dirty = computed(() => added.value.length + changed.value.length + removed.value.length > 0)

/** Why an added row's key can't be saved, or null. */
function keyProblem(row: Row): string | null {
  const problem = envKeyProblem(row.key)
  if (problem) return problem
  // A removed key counts too: undo the removal instead of adding it again.
  const taken = rows.value.some((r) => r !== row && r.key === row.key)
  return taken ? 'This key is already in the file.' : null
}
const canReview = computed(
  () => phase.value === 'edit' && dirty.value && added.value.every((r) => !keyProblem(r))
)

const lineCount = (value: string): number => value.split('\n').length

function conceal(): void {
  for (const r of rows.value) r.revealed = false
}

/** Any input in the editor restarts the minute before values are masked again. */
function touch(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(conceal, IDLE_MS)
}

function onVisibility(): void {
  if (document.hidden) conceal()
}

async function load(): Promise<void> {
  phase.value = 'loading'
  error.value = null
  conflict.value = false
  confirmDiscard.value = false
  rows.value = []
  const res = await call(() => window.envvault.openEditor(props.repo.name))
  if (!res.ok) {
    error.value = res.error.message
    phase.value = 'failed'
    return
  }
  expectedVaultHash = res.data.expectedVaultHash
  rows.value = res.data.entries.map((e) => ({
    id: nextId++,
    key: e.key,
    original: e.value,
    value: e.value,
    marked: e.marked,
    removed: false,
    revealed: false
  }))
  phase.value = 'edit'
  touch()
}

function addRow(): void {
  rows.value.push({
    id: nextId++,
    key: '',
    original: null,
    value: '',
    marked: false,
    removed: false,
    revealed: false
  })
}

function toggleRemove(row: Row): void {
  if (row.original === null) rows.value = rows.value.filter((r) => r !== row)
  else row.removed = !row.removed
}

function cancel(): void {
  if (phase.value === 'saving') return
  if (dirty.value && !confirmDiscard.value) {
    confirmDiscard.value = true
    return
  }
  emit('close')
}

async function save(): Promise<void> {
  if (phase.value !== 'review') return
  phase.value = 'saving'
  error.value = null
  // Plain objects only: a reactive proxy can't be cloned across contextBridge.
  const request = {
    repoName: props.repo.name,
    expectedVaultHash,
    set: changed.value.map((r) => ({ key: r.key, value: r.value })),
    add: added.value.map((r) => ({ key: r.key, value: r.value })),
    remove: removed.value.map((r) => r.key)
  }
  const res = await call(() => window.envvault.saveEdit(request))
  if (res.ok) {
    const { vault, changed: wrote } = res.data
    if (!wrote) toast('success', `Nothing changed in ${props.repo.name}.`)
    else {
      const pull = props.repo.hasEnv ? ' Pull to update your local .env.' : ''
      toast('success', `Saved ${props.repo.name} (v${vault?.version ?? '?'}).${pull}`)
    }
    emit('done')
    return
  }
  phase.value = 'edit'
  if (res.error.code === 'LOCKED') return
  error.value = res.error.message
  conflict.value = res.error.code === 'VAULT_CHANGED'
}

onMounted(() => {
  dialog.value?.showModal()
  document.addEventListener('visibilitychange', onVisibility)
  void load()
})

onBeforeUnmount(() => {
  document.removeEventListener('visibilitychange', onVisibility)
  if (idleTimer) clearTimeout(idleTimer)
  rows.value = []
})

// Close, dropping every value, if the session locks while the editor is open.
watch(
  () => store.lockEpoch,
  () => emit('close')
)
</script>

<template>
  <dialog
    ref="dialog"
    class="dialog dialog-wide"
    aria-labelledby="edit-title"
    @cancel.prevent="cancel"
  >
    <div class="dialog-header">
      <h2 id="edit-title">Edit vault copy: {{ repo.name }}</h2>
      <p class="muted small">
        Values are hidden until you show them. Comments and formatting in the file are kept.
      </p>
    </div>

    <div class="dialog-body" @input="touch" @keydown="touch" @pointerdown="touch">
      <div v-if="phase === 'loading'" class="row muted"><span class="spinner" /> Loading…</div>

      <!-- Review: key names only. -->
      <template v-else-if="phase === 'review' || phase === 'saving'">
        <div v-if="added.length" class="diff-group">
          <h3>Added ({{ added.length }})</h3>
          <div class="chips">
            <code v-for="r in added" :key="r.id" class="chip chip-added">{{ r.key }}</code>
          </div>
        </div>
        <div v-if="changed.length" class="diff-group">
          <h3>Changed ({{ changed.length }})</h3>
          <div class="chips">
            <code v-for="r in changed" :key="r.id" class="chip chip-changed">{{ r.key }}</code>
          </div>
        </div>
        <div v-if="removed.length" class="diff-group">
          <h3>Removed ({{ removed.length }})</h3>
          <div class="chips">
            <code v-for="r in removed" :key="r.id" class="chip chip-removed">{{ r.key }}</code>
          </div>
        </div>
        <p class="muted small">
          Saving writes a new version of the vault copy.
          <template v-if="repo.hasEnv">Your local .env changes only when you pull.</template>
        </p>
      </template>

      <template v-else-if="phase === 'edit'">
        <p v-if="rows.length === 0" class="muted">No keys yet.</p>
        <table v-else class="table editor-table">
          <thead>
            <tr>
              <th>Key</th>
              <th>Value</th>
              <th class="col-actions"><span class="muted">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="row in rows"
              :key="row.id"
              :class="{
                'editor-removed': row.removed,
                'editor-changed': isChanged(row),
                'editor-added': row.original === null
              }"
            >
              <td class="editor-key">
                <template v-if="row.original === null">
                  <input
                    v-model="row.key"
                    class="input mono"
                    placeholder="KEY_NAME"
                    aria-label="Key name"
                    spellcheck="false"
                    autocomplete="off"
                    autocapitalize="off"
                  />
                  <p v-if="keyProblem(row)" class="small editor-problem">
                    {{ keyProblem(row) }}
                  </p>
                </template>
                <code v-else>{{ row.key }}</code>
              </td>
              <td class="editor-value">
                <span v-if="row.marked" class="muted small">
                  Machine-specific: set on each machine
                </span>
                <span v-else-if="row.removed" class="muted small">Removed</span>
                <textarea
                  v-else-if="row.revealed"
                  v-model="row.value"
                  class="input mono editor-textarea"
                  :rows="lineCount(row.value)"
                  :aria-label="`Value of ${row.key || 'new key'}`"
                  spellcheck="false"
                  autocomplete="off"
                  autocapitalize="off"
                />
                <span v-else-if="row.value.includes('\n')" class="mono muted">
                  {{ MASK }} ({{ lineCount(row.value) }} lines)
                </span>
                <input
                  v-else
                  v-model="row.value"
                  type="password"
                  class="input mono"
                  :aria-label="`Value of ${row.key || 'new key'}`"
                  spellcheck="false"
                  autocomplete="off"
                  autocapitalize="off"
                />
              </td>
              <td class="col-actions">
                <div class="row">
                  <button
                    v-if="!row.marked && !row.removed"
                    type="button"
                    class="btn btn-sm"
                    @click="row.revealed = !row.revealed"
                  >
                    {{ row.revealed ? 'Hide' : 'Show' }}
                  </button>
                  <button type="button" class="btn btn-sm" @click="toggleRemove(row)">
                    {{ row.removed ? 'Undo' : 'Remove' }}
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
        <div>
          <button type="button" class="btn btn-sm" @click="addRow">Add key</button>
        </div>
      </template>

      <div v-if="conflict" class="notice notice-error stack" role="alert">
        <span>{{ error }}</span>
        <div>
          <button type="button" class="btn btn-sm" @click="load">
            Reload (discards your edits)
          </button>
        </div>
      </div>
      <p v-else-if="error" class="notice notice-error" role="alert">{{ error }}</p>

      <div v-if="confirmDiscard" class="notice notice-warn row">
        <span class="grow">Discard your changes?</span>
        <button type="button" class="btn btn-sm" @click="confirmDiscard = false">
          Keep editing
        </button>
        <button type="button" class="btn btn-sm btn-danger" @click="emit('close')">Discard</button>
      </div>
    </div>

    <div class="dialog-footer">
      <template v-if="phase === 'review' || phase === 'saving'">
        <button type="button" class="btn" :disabled="phase === 'saving'" @click="phase = 'edit'">
          Back
        </button>
        <button type="button" class="btn btn-primary" :disabled="phase === 'saving'" @click="save">
          <span v-if="phase === 'saving'" class="spinner" />
          Save to vault
        </button>
      </template>
      <template v-else>
        <button type="button" class="btn" @click="cancel">
          {{ phase === 'failed' ? 'Close' : 'Cancel' }}
        </button>
        <button
          v-if="phase !== 'failed'"
          type="button"
          class="btn btn-primary"
          :disabled="!canReview"
          @click="phase = 'review'"
        >
          Review changes
        </button>
      </template>
    </div>
  </dialog>
</template>
