import type { Result } from './result'
import type {
  AppState,
  EditorData,
  GhStatus,
  GitignoreResult,
  GitRepoChoice,
  PullPreview,
  PullRequest,
  PullResult,
  PushPreview,
  PushRequest,
  RawDiff,
  RawDiffRequest,
  RepoRow,
  SaveEditRequest,
  SaveEditResult,
  Settings,
  SkillInfo
} from './types'

// Response payload for each channel. main's `handle()` and the preload's
// `invoke()` are both typed against this map.
export interface Responses {
  'app:getState': AppState
  'app:activity': null
  'settings:get': Settings
  'settings:save': Settings
  'settings:pickFolder': Settings | null
  'settings:setGitVault': Settings
  'git:ghStatus': GhStatus
  'git:listRepos': GitRepoChoice[]
  'git:createRepo': Settings
  'git:openNewRepoPage': null
  'session:createVault': null
  'session:unlock': null
  'session:lock': null
  'repos:list': RepoRow[]
  'repo:previewPush': PushPreview
  'repo:push': RepoRow
  'repo:previewPull': PullPreview
  'repo:pull': PullResult
  'repo:pullRawDiff': RawDiff
  'repo:openEditor': EditorData
  'repo:saveEdit': SaveEditResult
  'repo:addGitignore': GitignoreResult
  'skill:status': SkillInfo
  'skill:install': SkillInfo
  'skill:remove': SkillInfo
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
    autoPull: boolean
    cliAccess: boolean
  }): R<'settings:save'>
  /** Opens a native folder picker. Resolves to null if cancelled. */
  pickFolder(which: 'projects' | 'vault'): R<'settings:pickFolder'>
  /**
   * Use a private git repository as the vault: checked (access, private,
   * empty or a vault already), then saved. Locks EnvVault, like a new folder.
   */
  setGitVault(url: string): R<'settings:setGitVault'>
  /** Whether the GitHub CLI is installed and signed in. */
  ghStatus(): R<'git:ghStatus'>
  /** Your private GitHub repositories, through the GitHub CLI. */
  listGitRepos(): R<'git:listRepos'>
  /** Create a private repository with the GitHub CLI and use it, like setGitVault. */
  createGitRepo(name: string): R<'git:createRepo'>
  /** Open GitHub's new-repository page (a fixed URL) in the browser. */
  openNewRepoPage(): R<'git:openNewRepoPage'>
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
  /** The vault copy as editor rows, values included (see EnvEditorDialog). */
  openEditor(repoName: string): R<'repo:openEditor'>
  /** Apply edits to the vault copy, if it is still the one openEditor returned. */
  saveEdit(request: SaveEditRequest): R<'repo:saveEdit'>
  addGitignore(repoName: string): R<'repo:addGitignore'>
  skillStatus(): R<'skill:status'>
  /** Write the Claude Code skill. `replace` overwrites a SKILL.md that differs. */
  installSkill(replace: boolean): R<'skill:install'>
  removeSkill(): R<'skill:remove'>
  /** Called when main locks the session. Returns an unsubscribe function. */
  onLocked(callback: () => void): () => void
  /**
   * Called with the rows automatic pull just pulled. Must not trigger IPC:
   * every request counts as activity and would keep the vault unlocked.
   */
  onAutoPulled(callback: (rows: RepoRow[]) => void): () => void
  /** Called with the row the envvault command just pushed. Must not trigger IPC either. */
  onCliPushed(callback: (row: RepoRow) => void): () => void
}
