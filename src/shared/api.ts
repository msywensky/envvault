import type { Result } from './result'
import type {
  AppState,
  GitignoreResult,
  PullPreview,
  PullRequest,
  PullResult,
  PushPreview,
  PushRequest,
  RawDiff,
  RawDiffRequest,
  RepoRow,
  Settings
} from './types'

// Response payload for each channel. main's `handle()` and the preload's
// `invoke()` are both typed against this map.
export interface Responses {
  'app:getState': AppState
  'app:activity': null
  'settings:get': Settings
  'settings:save': Settings
  'settings:pickFolder': Settings | null
  'session:createVault': null
  'session:unlock': null
  'session:lock': null
  'repos:list': RepoRow[]
  'repo:previewPush': PushPreview
  'repo:push': RepoRow
  'repo:previewPull': PullPreview
  'repo:pull': PullResult
  'repo:pullRawDiff': RawDiff
  'repo:addGitignore': GitignoreResult
}

type R<C extends keyof Responses> = Promise<Result<Responses[C]>>

// The API the preload exposes as `window.envvault`. Type-only.
export interface EnvVaultApi {
  getState(): R<'app:getState'>
  /** Throttled by the renderer; resets the idle auto-lock timer. */
  activity(): R<'app:activity'>
  getSettings(): R<'settings:get'>
  saveSettings(patch: {
    autoLockMinutes: number
    machineName: string
    checkExample: boolean
  }): R<'settings:save'>
  /** Opens a native folder picker. Resolves to null if cancelled. */
  pickFolder(which: 'projects' | 'vault'): R<'settings:pickFolder'>
  createVault(password: string): R<'session:createVault'>
  unlock(password: string): R<'session:unlock'>
  lock(): R<'session:lock'>
  listRepos(): R<'repos:list'>
  previewPush(repoName: string): R<'repo:previewPush'>
  push(request: PushRequest): R<'repo:push'>
  previewPull(repoName: string): R<'repo:previewPull'>
  pull(request: PullRequest): R<'repo:pull'>
  /** Line-by-line diff of what a pull would write, masked unless `values` is set. */
  pullRawDiff(request: RawDiffRequest): R<'repo:pullRawDiff'>
  addGitignore(repoName: string): R<'repo:addGitignore'>
  /** Called when main locks the session. Returns an unsubscribe function. */
  onLocked(callback: () => void): () => void
}
