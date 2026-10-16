<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue'
import ToastHost from './components/ToastHost.vue'
import { call, handleLocked, refreshState, run, store } from './store'
import LockScreen from './views/LockScreen.vue'
import ReposView from './views/ReposView.vue'
import SettingsView from './views/SettingsView.vue'
import SetupView from './views/SetupView.vue'

// Tell main the user is active (resets the idle auto-lock), at most every 30 s.
const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'wheel'] as const
let lastActivity = 0
function onActivity(): void {
  const now = Date.now()
  if (store.view !== 'repos' && store.view !== 'settings') return
  if (now - lastActivity < 30_000) return
  lastActivity = now
  void call(() => window.envvault.activity())
}

let unsubscribe: (() => void) | null = null

onMounted(async () => {
  unsubscribe = window.envvault.onLocked(() => void handleLocked())
  for (const e of ACTIVITY_EVENTS) window.addEventListener(e, onActivity, { passive: true })
  await refreshState()
})

onBeforeUnmount(() => {
  unsubscribe?.()
  for (const e of ACTIVITY_EVENTS) window.removeEventListener(e, onActivity)
})

async function lockNow(): Promise<void> {
  await run(() => window.envvault.lock())
}
</script>

<template>
  <SetupView v-if="store.view === 'setup'" />
  <LockScreen v-else-if="store.view === 'lock'" />
  <div v-else-if="store.view === 'repos' || store.view === 'settings'" class="shell">
    <header class="topbar">
      <div class="brand">
        <span class="brand-mark" aria-hidden="true">E</span>
        EnvVault
      </div>
      <nav class="tabs" aria-label="Main">
        <button
          type="button"
          class="tab"
          :class="{ 'tab-active': store.view === 'repos' }"
          @click="store.view = 'repos'"
        >
          Repositories
        </button>
        <button
          type="button"
          class="tab"
          :class="{ 'tab-active': store.view === 'settings' }"
          @click="store.view = 'settings'"
        >
          Settings
        </button>
      </nav>
      <span class="grow" />
      <span class="muted small">{{ store.settings?.machineName }}</span>
      <button type="button" class="btn btn-sm" @click="lockNow">Lock</button>
    </header>
    <main class="content">
      <ReposView v-if="store.view === 'repos'" />
      <SettingsView v-else />
    </main>
  </div>
  <main v-else class="center-screen">
    <div v-if="store.startupError" class="panel card">
      <div class="card-body stack">
        <h1>EnvVault couldn't start</h1>
        <p class="notice notice-error" role="alert">{{ store.startupError }}</p>
        <button type="button" class="btn btn-primary" @click="refreshState">Retry</button>
      </div>
    </div>
    <span v-else class="row muted"><span class="spinner" /> Loading…</span>
  </main>
  <ToastHost />
</template>
