// A small reactive store (no Pinia). It never holds env values: main sends
// key names, statuses and metadata, and the one response with values (the
// raw pull diff after "Show values") is fetched and held only by SyncDialog.
import { reactive } from 'vue'
import { autoPullMessage, cliPushMessage } from '../../shared/messages'
import type { Result } from '../../shared/result'
import type { AppState, RepoRow, Settings } from '../../shared/types'

export type View = 'loading' | 'setup' | 'lock' | 'repos' | 'settings'

export interface Toast {
  id: number
  kind: 'success' | 'error'
  text: string
}

export const store = reactive({
  view: 'loading' as View,
  app: null as AppState | null,
  settings: null as Settings | null,
  repos: [] as RepoRow[],
  reposLoaded: false,
  toasts: [] as Toast[],
  /** Set if the first state load failed, so the loading screen can offer Retry. */
  startupError: null as string | null,
  /** Bumped whenever the session locks, so open dialogs close themselves. */
  lockEpoch: 0,
  /** Mini mode's repo (see MiniView), or null for the full window. */
  mini: null as string | null
})

let nextToastId = 1

export function toast(kind: Toast['kind'], text: string): void {
  const id = nextToastId++
  store.toasts.push({ id, kind, text })
  setTimeout(() => dismissToast(id), kind === 'error' ? 7000 : 4000)
}

export function dismissToast(id: number): void {
  const i = store.toasts.findIndex((t) => t.id === id)
  if (i !== -1) store.toasts.splice(i, 1)
}

/**
 * Make an IPC call. Never throws. Takes a function rather than a promise so
 * that synchronous throws are caught too: contextBridge rejects arguments it
 * can't clone (such as Vue reactive proxies) by throwing before any promise
 * exists. Arguments must therefore be plain objects, never reactive ones.
 */
export async function call<T>(request: () => Promise<Result<T>>): Promise<Result<T>> {
  try {
    const res = await request()
    if (!res.ok && res.error.code === 'LOCKED') void handleLocked()
    return res
  } catch {
    return {
      ok: false,
      error: { code: 'INTERNAL', message: 'Lost contact with the app. Try restarting it.' }
    }
  }
}

/** call(), showing any error as a toast. Returns the data or null. */
export async function run<T>(request: () => Promise<Result<T>>): Promise<T | null> {
  const res = await call(request)
  if (res.ok) return res.data
  if (res.error.code !== 'LOCKED') toast('error', res.error.message)
  return null
}

/** Re-read app state and pick the screen to show. */
export async function refreshState(): Promise<void> {
  const [app, settings] = await Promise.all([
    call(() => window.envvault.getState()),
    call(() => window.envvault.getSettings())
  ])
  if (!app.ok || !settings.ok) {
    const failure = !app.ok ? app.error : !settings.ok ? settings.error : null
    if (failure?.code === 'LOCKED') return
    const message = failure?.message ?? 'Could not load the app state.'
    // On first load there is no screen to fall back to: show Retry instead.
    if (store.view === 'loading') store.startupError = message
    else toast('error', message)
    return
  }
  store.startupError = null
  store.app = app.data
  store.settings = settings.data
  applyView(app.data)
}

function applyView(app: AppState): void {
  // Setup needs the full window.
  if (!app.configured && store.mini) void exitMini()
  if (!app.configured) store.view = 'setup'
  else if (app.locked) store.view = store.view === 'setup' ? 'setup' : 'lock'
  else if (store.view !== 'settings') store.view = 'repos'
}

/** Main locked the session (button, idle timer, sleep, folder change). */
export async function handleLocked(): Promise<void> {
  store.repos = []
  store.reposLoaded = false
  store.lockEpoch++
  if (store.view === 'repos' || store.view === 'settings') store.view = 'lock'
  await refreshState()
}

// Rows that changed without the renderer asking (automatic pull, the
// envvault command). No IPC here: any request counts as activity, so
// refetching would keep the vault from ever auto-locking.
function patchRepos(rows: RepoRow[]): void {
  for (const row of rows) {
    const i = store.repos.findIndex((r) => r.name === row.name)
    if (i !== -1) store.repos[i] = row
  }
}

/** Rows main pulled in the background. */
export function applyAutoPulled(rows: RepoRow[]): void {
  patchRepos(rows)
  toast('success', autoPullMessage(rows))
}

/** A row the envvault command pushed. */
export function applyCliPushed(row: RepoRow): void {
  patchRepos([row])
  toast('success', cliPushMessage(row))
}

/** Mini mode's repo, rechecked by main. No toast: the badge shows it. */
export function applyRepoStatus(row: RepoRow): void {
  patchRepos([row])
}

/** Shrink the window to one repo. The view switches first, so it never shows squeezed. */
export async function enterMini(repoName: string): Promise<void> {
  store.mini = repoName
  const res = await call(() =>
    window.envvault.setLayout({ layout: 'mini', repoName, reviewing: false })
  )
  if (!res.ok) {
    store.mini = null
    if (res.error.code !== 'LOCKED') toast('error', res.error.message)
  }
}

/** Back to the full window. It grows first, then the full view replaces MiniView. */
export async function exitMini(): Promise<void> {
  await call(() => window.envvault.setLayout({ layout: 'full' }))
  store.mini = null
}

export async function loadRepos(): Promise<void> {
  const epoch = store.lockEpoch
  const rows = await run(() => window.envvault.listRepos())
  // A reply that raced a lock must not repopulate the cleared store.
  if (rows && epoch === store.lockEpoch) {
    store.repos = rows
    store.reposLoaded = true
  }
}
