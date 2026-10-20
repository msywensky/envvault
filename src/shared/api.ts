import type { FileRules } from './envrules'
import type { Result } from './result'
import type {
  AppState,
  EditorData,
  EnvFile,
  GhStatus,
  GitignoreResult,
  GitRepoChoice,
  Layout,
  PullPreview,
  PullRequest,
  PullResult,
  PushPreview,
  PushRequest,
  RawDiff,
  RawDiffRequest,
  RemoveRequest,
  RepoList,
  RepoRow,
  RepoSettingsRequest,
  SaveEditRequest,
  SaveEditResult,
  Settings,
  SettingsRequest,
  SkillInfo,
  VaultNameRequest
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
  'session:createVault': { setupCode: string | null }
  'session:unlock': null
  'session:lock': null
  'vault:showSetupCode': { setupCode: string }
  'repos:list': RepoList
  'repo:previewPush': PushPreview
  'repo:push': RepoRow
  'repo:previewPull': PullPreview
  'repo:pull': PullResult
  'repo:pullRawDiff': RawDiff
  'repo:openEditor': EditorData
  'repo:saveEdit': SaveEditResult
  'repo:removeFromVault': null
  'repo:addGitignore': GitignoreResult
  'repo:saveSettings': null
  'repo:setVaultName': null
  'vault:saveDefaults': null
  'vault:resetSettings': null
  'skill:status': SkillInfo
  'skill:install': SkillInfo
  'skill:remove': SkillInfo
  'window:setLayout': null
}

type R<C extends keyof Responses> = Promise<Result<Responses[C]>>

// The API the preload exposes as `window.envvault`. Type-only.
export interface EnvVaultApi {
  getState(): R<'app:getState'>
  /** Throttled by the renderer; resets the idle auto-lock timer. */
  activity(): R<'app:activity'>
  getSettings(): R<'settings:get'>
  saveSettings(settings: SettingsRequest): R<'settings:save'>
  /** Opens a native folder picker. Resolves to null if cancelled. */
  pickFolder(which: 'projects' | 'vault'): R<'settings:pickFolder'>
  /**
   * Use a private git repository as the vault: checked (access, private,
   * empty or a vault already), then saved. Locks EnvVault, like a new folder.
   * A host whose privacy can't be checked fails with GIT_VAULT_UNVERIFIED;
   * `confirmPrivate` is the user's word that the repository is private. It
   * never overrides a repository found to be public.
   */
  setGitVault(url: string, confirmPrivate?: boolean): R<'settings:setGitVault'>
  /** Whether the GitHub CLI is installed and signed in. */
  ghStatus(): R<'git:ghStatus'>
  /** Your private GitHub repositories, through the GitHub CLI. */
  listGitRepos(): R<'git:listRepos'>
  /** Create a private repository with the GitHub CLI and use it, like setGitVault. */
  createGitRepo(name: string): R<'git:createRepo'>
  /** Open GitHub's new-repository page (a fixed URL) in the browser. */
  openNewRepoPage(): R<'git:openNewRepoPage'>
  /** Create the vault and unlock it. With `setupCode` (always for git), returns the code to show. */
  createVault(password: string, setupCode: boolean): R<'session:createVault'>
  /** `setupCode` only when this machine doesn't have it yet (AppState.setupCode 'needed'). */
  unlock(password: string, setupCode?: string): R<'session:unlock'>
  lock(): R<'session:lock'>
  /** This machine's setup code for the vault, after checking the password. Unlocked only. */
  showSetupCode(password: string): R<'vault:showSetupCode'>
  /**
   * Every repo, a row per env file of those that aren't ignored, and the repo
   * settings. `rescan` asks git again which env files each repo has; without
   * it, the files found last time are used.
   */
  listRepos(rescan: boolean): R<'repos:list'>
  previewPush(file: EnvFile): R<'repo:previewPush'>
  push(request: PushRequest): R<'repo:push'>
  previewPull(file: EnvFile): R<'repo:previewPull'>
  pull(request: PullRequest): R<'repo:pull'>
  /** Line-by-line diff of what a pull would write, masked unless `values` is set. */
  pullRawDiff(request: RawDiffRequest): R<'repo:pullRawDiff'>
  /** The vault copy as editor rows, values included (see EnvEditorDialog). */
  openEditor(file: EnvFile): R<'repo:openEditor'>
  /** Apply edits to the vault copy, if it is still the one openEditor returned. */
  saveEdit(request: SaveEditRequest): R<'repo:saveEdit'>
  /** Delete an env file's vault copy, if it is still at `expectedVaultHash`. Local files stay. */
  removeFromVault(request: RemoveRequest): R<'repo:removeFromVault'>
  addGitignore(file: EnvFile): R<'repo:addGitignore'>
  /** Save a repo's settings in the vault, for every machine, by its vault name. */
  saveRepoSettings(request: RepoSettingsRequest): R<'repo:saveSettings'>
  /** Sync a folder as another name in the vault, on this machine only. */
  setVaultName(request: VaultNameRequest): R<'repo:setVaultName'>
  /** Save the env file rules repos without their own use, for every machine. */
  saveDefaults(rules: FileRules): R<'vault:saveDefaults'>
  /** Replace repo settings that failed verification with empty ones. */
  resetSettings(): R<'vault:resetSettings'>
  skillStatus(): R<'skill:status'>
  /** Write the Claude Code skill. `replace` overwrites a SKILL.md that differs. */
  installSkill(replace: boolean): R<'skill:install'>
  removeSkill(): R<'skill:remove'>
  /** Switch between the full window and mini mode on one env file. */
  setLayout(layout: Layout): R<'window:setLayout'>
  /** Called when main locks the session. Returns an unsubscribe function. */
  onLocked(callback: () => void): () => void
  /**
   * Called with the rows automatic pull just pulled. Must not trigger IPC:
   * every request counts as activity and would keep the vault unlocked.
   */
  onAutoPulled(callback: (rows: RepoRow[]) => void): () => void
  /** Called with the row the envvault command just pushed. Must not trigger IPC either. */
  onCliPushed(callback: (row: RepoRow) => void): () => void
  /** Called with mini mode's env file when main rechecks it. Must not trigger IPC either. */
  onRepoStatus(callback: (row: RepoRow) => void): () => void
}
