// A small reactive store (no Pinia). It never holds env values: main sends
// key names, statuses and metadata, and the responses with values (after a
// "Show values" click, and the editor's) are fetched and held only by the
// dialog that shows them.
import { reactive } from 'vue'
import { sameFile } from '../../shared/envfile'
import { autoPullMessage, cliPushMessage } from '../../shared/messages'
import type { Result } from '../../shared/result'
import type {
  AppState,
  EnvFile,
  RepoInfo,
  RepoRow,
  RepoSettingsView,
  Settings,
  SettingsRequest
} from '../../shared/types'
import { fileOf } from './status'

export type View = 'loading' | 'setup' | 'lock' | 'repos' | 'settings'

/** Settings' tabs (see SettingsView). */
export type SettingsTab = 'general' | 'sync' | 'cli'

export interface Toast {
  id: number
  kind: 'success' | 'error'
  text: string
}

/** What mini mode shows: one env file, or every env file of one repo. */
export interface MiniTarget {
  repoName: string
  paths: string[]
}

export const store = reactive({
  view: 'loading' as View,
  app: null as AppState | null,
  settings: null as Settings | null,
  /** The Settings tab to show, for this run only. */
  settingsTab: 'general' as SettingsTab,
  /** A row per env file of the repos that aren't ignored. */
  repos: [] as RepoRow[],
  /** Every repo, ignored ones included (see RepoInfo). */
  repoInfo: [] as RepoInfo[],
  /** The repo settings in the vault, as of the last list. */
  repoSettings: null as RepoSettingsView | null,
  reposLoaded: false,
  toasts: [] as Toast[],
  /** Set if the first state load failed, so the loading screen can offer Retry. */
  startupError: null as string | null,
  /** Bumped whenever the session locks, so open dialogs close themselves. */
  lockEpoch: 0,
  /** Mini mode's target (see MiniView), or null for the full window. */
  mini: null as MiniTarget | null,
  /** A conflict to open the Resolve dialog for once the full window is back (see MiniView). */
  resolveFile: null as EnvFile | null
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

/**
 * Save some of this machine's settings. settings:save takes them all, so the
 * others are sent as saved: one tab's Save never saves another tab's edits.
 * Returns whether it saved.
 */
export async function saveSettings(changes: Partial<SettingsRequest>): Promise<boolean> {
  const s = store.settings
  if (!s) return false
  const request: SettingsRequest = {
    autoLock: s.autoLock,
    autoLockMinutes: s.autoLockMinutes,
    machineName: s.machineName,
    checkExample: s.checkExample,
    autoPull: s.autoPull,
    backups: s.backups,
    backupCount: s.backupCount,
    cliAccess: s.cliAccess,
    miniOnTop: s.miniOnTop,
    ...changes
  }
  const saved = await run(() => window.envvault.saveSettings(request))
  if (saved) store.settings = saved
  return saved !== null
}

/** True if any of these differ from the saved settings. */
export function unsavedSettings(draft: Partial<SettingsRequest>): boolean {
  const saved = store.settings
  if (!saved) return false
  return (Object.keys(draft) as (keyof SettingsRequest)[]).some((k) => draft[k] !== saved[k])
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
  store.repoInfo = []
  store.repoSettings = null
  store.reposLoaded = false
  store.lockEpoch++
  if (store.view === 'repos' || store.view === 'settings') store.view = 'lock'
  await refreshState()
}

// Rows that changed without the renderer asking (automatic pull, the
// envvault command). No IPC here: any request counts as activity, so
// refetching would keep the vault from ever auto-locking. A row is one env
// file, so they are matched by file, never by repo name alone.
function patchRepos(rows: RepoRow[]): void {
  for (const row of rows) {
    const i = store.repos.findIndex((r) => sameFile(r, row))
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

/** Mini mode's rows, rechecked by main. No toast: the badges show them. */
export function applyRepoStatus(rows: RepoRow[]): void {
  patchRepos(rows)
}

/** Shrink the window to one env file. The view switches first, so it never shows squeezed. */
export async function enterMini(row: RepoRow): Promise<void> {
  await enterMiniTarget(row.name, [fileOf(row).path], !row.error)
}

/** Shrink the window to all of a repo's env files. */
export async function enterMiniRepo(rows: RepoRow[]): Promise<void> {
  const repoName = rows[0]?.name
  const paths = rows.flatMap((row) => (row.path === null ? [] : [row.path]))
  if (repoName === undefined || paths.length === 0) return
  await enterMiniTarget(repoName, paths, false)
}

async function enterMiniTarget(repoName: string, paths: string[], compact: boolean): Promise<void> {
  store.mini = { repoName, paths }
  const res = await call(() =>
    window.envvault.setLayout({ layout: 'mini', repoName, paths, reviewing: false, compact })
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

/**
 * Load every row. `rescan` asks git again which env files each repo has: for
 * opening the list and Refresh, not for reloading after a push or pull.
 */
export async function loadRepos(rescan = false): Promise<void> {
  const epoch = store.lockEpoch
  const list = await run(() => window.envvault.listRepos(rescan))
  // A reply that raced a lock must not repopulate the cleared store.
  if (list && epoch === store.lockEpoch) {
    store.repos = list.rows
    store.repoInfo = list.repos
    store.repoSettings = list.settings
    store.reposLoaded = true
  }
}
