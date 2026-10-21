<script setup lang="ts">
// Mini mode: one env file, or all of a repo's env files, in a small window. A
// single file's name, status chip and Push (or Pull) button sit in the header;
// a repo's files get a row each. Main keeps the rows fresh (EV.repoStatus, see
// src/main/mini.ts), so nothing here polls. A push or pull still goes through
// SyncDialog's review; the window grows while it's open. The Merge and Resolve
// dialog doesn't fit, so Merge… and Resolve… go back to the full window and open
// it there. When the vault locks, a compact unlock form takes over; anything it
// can't handle (a setup code, no vault yet) goes back to the full window too.
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { sameFile } from '../../../shared/envfile'
import type { RepoRow } from '../../../shared/types'
import StatusBadge from '../components/StatusBadge.vue'
import SyncDialog from '../components/SyncDialog.vue'
import { call, exitMini, loadRepos, refreshState, run, store } from '../store'
import {
  ACTION_LABEL,
  absoluteTime,
  actionsFor,
  fileOf,
  fileTitle,
  relativeTime,
  rowKey,
  type RowAction
} from '../status'

const target = computed(() => store.mini)
const single = computed(() => target.value?.paths.length === 1)
const name = computed(() => {
  const t = target.value
  if (!t) return ''
  const path = t.paths[0]
  return path === undefined ? t.repoName : fileTitle({ name: t.repoName, path })
})
// Matched by file, in the target's order: a repo has a row per env file.
const rows = computed(() => {
  const t = target.value
  if (!t) return []
  return t.paths.flatMap((path) => {
    const file = { name: t.repoName, local: true, path, storedName: null }
    const row = store.repos.find((r) => sameFile(r, file))
    return row ? [row] : []
  })
})
const row = computed(() => rows.value[0] ?? null)
const locked = computed(() => store.view === 'lock')
// The compact form only takes a password; a setup code needs the full lock screen.
const canUnlockHere = computed(
  () => store.app?.vault === 'ready' && store.app.setupCode !== 'needed'
)
const onTop = computed(() => store.settings?.miniOnTop ?? true)
// One row when the single file is unlocked and fine: the second row is only for
// a message, the unlock form or the loading state. A repo's list always has it.
const compact = computed(
  () => single.value && !locked.value && store.reposLoaded && row.value !== null && !row.value.error
)
const actions = computed(() => (single.value && row.value ? actionsFor(row.value) : []))
// Merge… or Resolve…: the dialog opens in the full window.
const merging = computed(() => actions.value.find((a) => a === 'merge' || a === 'resolve') ?? null)

interface RowView {
  row: RepoRow
  /** The buttons this row offers, apart from Merge…/Resolve… (see `merging`). */
  actions: RowAction[]
  merging: RowAction | null
  mergingLabel: string
}

const rowViews = computed<RowView[]>(() =>
  rows.value.map((row) => {
    const all = actionsFor(row)
    const merging = all.find((a) => a === 'merge' || a === 'resolve') ?? null
    return {
      row,
      actions: merging ? [] : all,
      merging,
      mergingLabel: merging ? ACTION_LABEL[merging] : ''
    }
  })
)

/** The vault copy's details for a row's tooltip, if it has one. */
function vaultInfo(row: RepoRow | null): string {
  const v = row?.vault
  if (!v) return ''
  return `Vault copy v${v.version} from ${v.updatedBy}, ${relativeTime(v.updatedAt)} (${absoluteTime(v.updatedAt)})`
}

const open = ref<{ repo: RepoRow; mode: 'push' | 'pull'; conflict: boolean } | null>(null)
const busy = ref(false)
// The password lives only here, cleared once sent.
const password = ref('')
const error = ref<string | null>(null)
const passwordInput = ref<HTMLInputElement | null>(null)

async function review(repo: RepoRow, action: RowAction): Promise<void> {
  const t = target.value
  if (!t) return
  // Grow first, so the dialog opens at its full size.
  const res = await call(() =>
    window.envvault.setLayout({
      layout: 'mini',
      repoName: t.repoName,
      paths: [...t.paths],
      reviewing: true,
      compact: compact.value
    })
  )
  if (!res.ok) return
  const mode = action === 'push' || action === 'keep-local' ? 'push' : 'pull'
  open.value = { repo, mode, conflict: action === 'keep-local' || action === 'keep-vault' }
}

/** Open the Resolve dialog in the full window (see ReposView). */
async function resolve(file: RepoRow): Promise<void> {
  store.resolveFile = fileOf(file)
  await exitMini()
}

/** Resize to the current state: the header, a message, or the review dialog. */
async function applyLayout(reviewing: boolean): Promise<void> {
  const t = store.mini
  if (!t) return
  // Plain copies: store.mini is reactive, which IPC can't clone.
  const { repoName, paths } = t
  await call(() =>
    window.envvault.setLayout({
      layout: 'mini',
      repoName,
      paths: [...paths],
      reviewing,
      compact: compact.value
    })
  )
}

async function closeReview(done: boolean): Promise<void> {
  open.value = null
  await applyLayout(false)
  if (done) await loadRepos()
}

async function toggleOnTop(): Promise<void> {
  const s = store.settings
  if (!s) return
  busy.value = true
  // A plain copy: store.settings is reactive, which IPC can't clone.
  const saved = await run(() =>
    window.envvault.saveSettings({
      autoLock: s.autoLock,
      autoLockMinutes: s.autoLockMinutes,
      machineName: s.machineName,
      checkExample: s.checkExample,
      autoPull: s.autoPull,
      backups: s.backups,
      backupCount: s.backupCount,
      cliAccess: s.cliAccess,
      miniOnTop: !s.miniOnTop
    })
  )
  busy.value = false
  if (saved) store.settings = saved
}

async function unlock(): Promise<void> {
  if (busy.value || !password.value) return
  busy.value = true
  error.value = null
  const pw = password.value
  const res = await call(() => window.envvault.unlock(pw))
  password.value = ''
  busy.value = false
  if (!res.ok) {
    error.value = res.error.message
    await focusPassword()
    return
  }
  store.view = 'repos'
  await refreshState()
}

async function lockNow(): Promise<void> {
  await run(() => window.envvault.lock())
}

async function focusPassword(): Promise<void> {
  await nextTick()
  passwordInput.value?.focus()
}

async function refresh(): Promise<void> {
  if (!locked.value && !store.reposLoaded) await loadRepos()
}

onMounted(async () => {
  if (locked.value) await focusPassword()
  else await refresh()
})

// An open dialog closes itself on lock, which shrinks the window back.
watch(locked, async (now) => {
  if (now) {
    error.value = null
    await focusPassword()
  } else {
    password.value = ''
    await refresh()
  }
  if (!open.value) await applyLayout(false)
})

// The second row comes and goes with the message, the loading state or the
// unlock form. Leave it alone while the review dialog owns the window's size.
watch(compact, async () => {
  if (open.value) return
  await applyLayout(false)
})
</script>

<template>
  <main class="mini">
    <header class="mini-header">
      <!-- The repo's name, or why the last unlock failed. -->
      <span v-if="locked && error" class="mini-error truncate grow" role="alert" :title="error">
        {{ error }}
      </span>
      <div v-else class="mini-title grow" :title="single ? vaultInfo(row) : ''">
        <span class="repo-name truncate" :title="name">{{ name }}</span>
        <StatusBadge v-if="single && !locked && row" :status="row.status" />
      </div>
      <template v-if="!locked && single && row">
        <button
          v-if="merging"
          type="button"
          class="btn btn-sm"
          :class="{ 'btn-primary': merging === 'merge' }"
          :title="
            merging === 'merge'
              ? 'Review the merge, in the full window'
              : 'Choose which copy each key comes from, in the full window'
          "
          @click="resolve(row)"
        >
          {{ ACTION_LABEL[merging] }}
        </button>
        <button
          v-for="action in merging ? [] : actions"
          :key="action"
          type="button"
          class="btn btn-sm btn-primary"
          @click="review(row, action)"
        >
          {{ ACTION_LABEL[action] }}
        </button>
      </template>
      <button
        type="button"
        class="btn btn-sm"
        :class="{ 'btn-toggled': onTop }"
        :aria-pressed="onTop"
        :disabled="busy"
        title="Keep this window above other windows"
        @click="toggleOnTop"
      >
        On top
      </button>
      <button v-if="!locked" type="button" class="btn btn-sm" @click="lockNow">Lock</button>
      <button type="button" class="btn btn-sm" title="Back to all repositories" @click="exitMini">
        Full view
      </button>
    </header>

    <form v-if="locked && canUnlockHere" class="mini-body" @submit.prevent="unlock">
      <input
        ref="passwordInput"
        v-model="password"
        class="input grow"
        type="password"
        placeholder="Master password"
        aria-label="Master password"
        autocomplete="current-password"
        :aria-invalid="error !== null"
        :disabled="busy"
      />
      <button type="submit" class="btn btn-primary" :disabled="busy || !password">
        <span v-if="busy" class="spinner" />
        Unlock
      </button>
    </form>

    <div v-else-if="locked" class="mini-body">
      <span class="muted small">Locked. Use Full view to unlock.</span>
    </div>

    <div v-else-if="!store.reposLoaded" class="mini-body">
      <span class="row muted"><span class="spinner" /> Loading…</span>
    </div>

    <div v-else-if="single && !row" class="mini-body">
      <span class="muted small">This .env is no longer in the projects folder.</span>
    </div>

    <div v-else-if="single && row && row.error" class="mini-body" :title="vaultInfo(row)">
      <span class="mini-error truncate" :title="row.error.message">
        {{ row.error.message }}
      </span>
    </div>

    <div v-else-if="!single" class="mini-files">
      <div
        v-for="line in rowViews"
        :key="rowKey(line.row)"
        class="mini-row"
        :title="vaultInfo(line.row)"
      >
        <span class="file-path truncate grow">{{ line.row.path }}</span>
        <StatusBadge :status="line.row.status" />
        <button
          v-if="line.merging"
          type="button"
          class="btn btn-sm"
          :class="{ 'btn-primary': line.merging === 'merge' }"
          :title="
            line.merging === 'merge'
              ? 'Review the merge, in the full window'
              : 'Choose which copy each key comes from, in the full window'
          "
          @click="resolve(line.row)"
        >
          {{ line.mergingLabel }}
        </button>
        <button
          v-for="action in line.actions"
          :key="action"
          type="button"
          class="btn btn-sm btn-primary"
          @click="review(line.row, action)"
        >
          {{ ACTION_LABEL[action] }}
        </button>
      </div>
      <div v-if="rowViews.length === 0" class="mini-row muted small">
        These env files are no longer in the projects folder.
      </div>
    </div>

    <SyncDialog
      v-if="open"
      :key="rowKey(open.repo) + open.mode"
      :repo="open.repo"
      :mode="open.mode"
      :conflict="open.conflict"
      @close="closeReview(false)"
      @done="closeReview(true)"
    />
  </main>
</template>
