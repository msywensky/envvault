<script setup lang="ts">
// Mini mode: one env file in a small window, two rows tall. The header holds its
// Push (or Pull) button with the window's controls, and the row below its
// status. Main keeps the row fresh (EV.repoStatus, see src/main/mini.ts), so
// nothing here polls. A push or pull still goes through SyncDialog's review;
// the window grows while it's open. A conflict's two choices don't fit, so
// Resolve goes back to the full window. When the vault locks, a compact
// unlock form takes over; anything it can't handle (a setup code, no vault
// yet) goes back to the full window too.
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { sameFile } from '../../../shared/envfile'
import type { RepoRow } from '../../../shared/types'
import StatusBadge from '../components/StatusBadge.vue'
import SyncDialog from '../components/SyncDialog.vue'
import { call, exitMini, loadRepos, refreshState, run, store } from '../store'
import {
  ACTION_LABEL,
  STATUS_HINT,
  absoluteTime,
  actionsFor,
  fileOf,
  fileTitle,
  relativeTime,
  rowKey,
  type RowAction
} from '../status'

const shown = computed(() =>
  store.mini
    ? { name: store.mini.repoName, local: true, path: store.mini.path, storedName: null }
    : null
)
const name = computed(() => (shown.value ? fileTitle(shown.value) : ''))
// Matched by file: a repo has a row per env file.
const row = computed(() => {
  const file = shown.value
  return file ? (store.repos.find((r) => sameFile(r, file)) ?? null) : null
})
const locked = computed(() => store.view === 'lock')
// The compact form only takes a password; a setup code needs the full lock screen.
const canUnlockHere = computed(
  () => store.app?.vault === 'ready' && store.app.setupCode !== 'needed'
)
const onTop = computed(() => store.settings?.miniOnTop ?? true)
const actions = computed(() => (row.value ? actionsFor(row.value) : []))
const conflict = computed(() => row.value?.status === 'conflict' && actions.value.length > 1)
const vaultInfo = computed(() => {
  const v = row.value?.vault
  if (!v) return ''
  return `Vault copy v${v.version} from ${v.updatedBy}, ${relativeTime(v.updatedAt)} (${absoluteTime(v.updatedAt)})`
})

const open = ref<{ repo: RepoRow; mode: 'push' | 'pull'; conflict: boolean } | null>(null)
const busy = ref(false)
// The password lives only here, cleared once sent.
const password = ref('')
const error = ref<string | null>(null)
const passwordInput = ref<HTMLInputElement | null>(null)

async function review(repo: RepoRow, action: RowAction): Promise<void> {
  const file = fileOf(repo)
  // Grow first, so the dialog opens at its full size.
  const res = await call(() =>
    window.envvault.setLayout({ layout: 'mini', ...file, reviewing: true })
  )
  if (!res.ok) return
  const mode = action === 'push' || action === 'keep-local' ? 'push' : 'pull'
  open.value = { repo, mode, conflict: action === 'keep-local' || action === 'keep-vault' }
}

async function closeReview(done: boolean): Promise<void> {
  open.value = null
  const mini = store.mini
  if (mini) {
    // A plain copy: store.mini is reactive, which IPC can't clone.
    const { repoName, path } = mini
    await call(() =>
      window.envvault.setLayout({ layout: 'mini', repoName, path, reviewing: false })
    )
  }
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
})
</script>

<template>
  <main class="mini">
    <header class="mini-header">
      <!-- The repo's name, or why the last unlock failed. -->
      <span v-if="locked && error" class="mini-error truncate grow" role="alert" :title="error">
        {{ error }}
      </span>
      <span v-else class="repo-name truncate grow" :title="name">{{ name }}</span>
      <template v-if="!locked && row">
        <button
          v-if="conflict"
          type="button"
          class="btn btn-sm"
          title="Choose which copy to keep, in the full window"
          @click="exitMini"
        >
          Resolve…
        </button>
        <button
          v-for="action in conflict ? [] : actions"
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

    <div v-else-if="!row" class="mini-body">
      <span class="muted small">This .env is no longer in the projects folder.</span>
    </div>

    <div v-else class="mini-body" :title="vaultInfo">
      <StatusBadge :status="row.status" />
      <span v-if="row.error" class="mini-error truncate" :title="row.error.message">
        {{ row.error.message }}
      </span>
      <span v-else class="muted small truncate" :title="STATUS_HINT[row.status]">
        {{ STATUS_HINT[row.status] }}
      </span>
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
