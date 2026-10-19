<script setup lang="ts">
// Mini mode: one repo in a small window, its status and its Push (or Pull)
// button. Main keeps the row fresh (EV.repoStatus, see src/main/mini.ts), so
// nothing here polls. A push or pull still goes through SyncDialog's review;
// the window grows while it's open. When the vault locks, a compact unlock
// form takes over; anything it can't handle (a setup code, no vault yet) goes
// back to the full window.
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import type { RepoRow } from '../../../shared/types'
import StatusBadge from '../components/StatusBadge.vue'
import SyncDialog from '../components/SyncDialog.vue'
import { call, exitMini, loadRepos, refreshState, run, store } from '../store'
import {
  ACTION_LABEL,
  STATUS_HINT,
  absoluteTime,
  actionsFor,
  relativeTime,
  type RowAction
} from '../status'

const name = computed(() => store.mini ?? '')
const row = computed(() => store.repos.find((r) => r.name === store.mini) ?? null)
const locked = computed(() => store.view === 'lock')
// The compact form only takes a password; a setup code needs the full lock screen.
const canUnlockHere = computed(
  () => store.app?.vault === 'ready' && store.app.setupCode !== 'needed'
)
const onTop = computed(() => store.settings?.miniOnTop ?? true)

const open = ref<{ repo: RepoRow; mode: 'push' | 'pull'; conflict: boolean } | null>(null)
const busy = ref(false)
// The password lives only here, cleared once sent.
const password = ref('')
const error = ref<string | null>(null)
const passwordInput = ref<HTMLInputElement | null>(null)

async function review(repo: RepoRow, action: RowAction): Promise<void> {
  const repoName = repo.name
  // Grow first, so the dialog opens at its full size.
  const res = await call(() =>
    window.envvault.setLayout({ layout: 'mini', repoName, reviewing: true })
  )
  if (!res.ok) return
  const mode = action === 'push' || action === 'keep-local' ? 'push' : 'pull'
  open.value = { repo, mode, conflict: action === 'keep-local' || action === 'keep-vault' }
}

async function closeReview(done: boolean): Promise<void> {
  open.value = null
  const repoName = name.value
  await call(() => window.envvault.setLayout({ layout: 'mini', repoName, reviewing: false }))
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
      <span class="repo-name truncate grow" :title="name">{{ name }}</span>
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
      <div class="row">
        <input
          ref="passwordInput"
          v-model="password"
          class="input grow"
          type="password"
          placeholder="Master password"
          aria-label="Master password"
          autocomplete="current-password"
          :disabled="busy"
        />
        <button type="submit" class="btn btn-primary" :disabled="busy || !password">
          <span v-if="busy" class="spinner" />
          Unlock
        </button>
      </div>
      <p v-if="error" class="mini-error" role="alert">{{ error }}</p>
      <p v-else class="muted small">EnvVault is locked.</p>
    </form>

    <div v-else-if="locked" class="mini-body">
      <p class="muted small">EnvVault is locked, and needs the full window to unlock.</p>
      <div class="row">
        <button type="button" class="btn btn-primary" @click="exitMini">Open full window</button>
      </div>
    </div>

    <div v-else-if="!store.reposLoaded" class="mini-body">
      <span class="row muted"><span class="spinner" /> Loading…</span>
    </div>

    <div v-else-if="!row" class="mini-body">
      <p class="muted small">This repo is no longer in the projects folder.</p>
    </div>

    <div v-else class="mini-body">
      <div class="row">
        <StatusBadge :status="row.status" />
        <span
          v-if="row.vault"
          class="muted small truncate"
          :title="absoluteTime(row.vault.updatedAt)"
        >
          v{{ row.vault.version }} · {{ row.vault.updatedBy }} ·
          {{ relativeTime(row.vault.updatedAt) }}
        </span>
      </div>
      <p v-if="row.error" class="mini-error">{{ row.error.message }}</p>
      <p v-else class="muted small">{{ STATUS_HINT[row.status] }}</p>
      <div v-if="actionsFor(row).length" class="row">
        <button
          v-for="(action, i) in actionsFor(row)"
          :key="action"
          type="button"
          class="btn"
          :class="{ 'btn-primary': i === 0 && row.status !== 'conflict' }"
          @click="review(row, action)"
        >
          {{ ACTION_LABEL[action] }}
        </button>
      </div>
    </div>

    <SyncDialog
      v-if="open"
      :key="open.repo.name + open.mode"
      :repo="open.repo"
      :mode="open.mode"
      :conflict="open.conflict"
      @close="closeReview(false)"
      @done="closeReview(true)"
    />
  </main>
</template>
