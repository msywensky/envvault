// Plain data types shared by main, core and the renderer. Type-only, so the
// renderer can import them without pulling in node code. None of these carry
// env values, except a RawDiff requested with `values: true` (see
// sync.pullRawDiff).
import type { FileRules } from './envrules'
import type { AppErrorInfo } from './result'

export type SyncStatus =
  'vault-only' | 'no-env' | 'local-only' | 'vault-newer' | 'in-sync' | 'local-newer' | 'conflict'

/**
 * One env file: a repo in the projects folder by name, and the file's path in
 * it from the repo root, with "/" separators: ".env" for the repo's own, or
 * "apps/web/.env" (see src/core/envpath.ts).
 */
export interface EnvFile {
  repoName: string
  path: string
}

/**
 * A repo's own settings, kept in the vault for every machine (see
 * src/core/vaultsettings.ts). A null list means it uses the vault's defaults.
 */
export interface RepoRules {
  /** EnvVault leaves the repo alone: no reads, pushes or pulls. */
  ignored: boolean
  include: string[] | null
  exclude: string[] | null
}

/** Metadata about the vault copy of one repo. No values. */
export interface VaultInfo {
  version: number
  contentHash: string
  updatedBy: string
  updatedAt: string
}

/** What this machine last pushed or pulled for one repo. */
export interface LastSync {
  version: number
  contentHash: string
}

/** Key-name diff. Never contains values. */
export interface DiffResult {
  added: string[]
  removed: string[]
  changed: string[]
  unchanged: number
}

/**
 * One row of a line-by-line diff, for the raw diff in the Pull dialog. Its
 * text is masked unless the diff was requested with `values: true`, in which
 * case it CARRIES ENV VALUES. Unchanged lines away from any change are sent
 * as a `gap` count, never as text.
 */
export type RawDiffLine =
  | { kind: 'same' | 'add' | 'del'; text: string; oldNo: number | null; newNo: number | null }
  | { kind: 'gap'; count: number }

/**
 * One row of the vault-copy editor. Unlike every other type here it carries
 * a value; it exists only in EnvEditorDialog (see repo:openEditor).
 */
export interface EditorEntry {
  key: string
  value: string
  /** Machine-specific (# envvault:local): the vault holds no value for it. */
  marked: boolean
}

export interface EditorData {
  /** In file order. */
  entries: EditorEntry[]
  vault: VaultInfo | null
  /** Pass back to saveEdit, which refuses if the vault copy changed meanwhile. */
  expectedVaultHash: string | null
}

export interface EnvChange {
  key: string
  value: string
}

export interface SaveEditRequest extends EnvFile {
  expectedVaultHash: string | null
  set: EnvChange[]
  add: EnvChange[]
  remove: string[]
}

export interface SaveEditResult {
  vault: VaultInfo | null
  /** False if the edits left the vault copy as it was, so nothing was written. */
  changed: boolean
}

/** Local .env -> vault copy. Empty when no line changes (line endings only). */
export interface RawDiff {
  lines: RawDiffLine[]
}

/**
 * Where the vault is kept: a synced folder, or a branch of a private git repository.
 * `privateConfirmed`: the host gave no clear answer to the anonymous privacy
 * check (an SSH-only server, say) and the user confirmed the repository is private.
 */
export type VaultLocation =
  | { kind: 'folder'; path: string }
  | { kind: 'git'; url: string; branch: string; privateConfirmed?: true }

export interface Settings {
  projectsPath: string | null
  vault: VaultLocation | null
  /**
   * Lock after `autoLockMinutes` without activity. When off, only Lock, sleep, a screen lock
   * or closing the window locks.
   */
  autoLock: boolean
  autoLockMinutes: number
  machineName: string
  /** Compare .env with .env.example in the push and pull dialogs. */
  checkExample: boolean
  /** Pull one-sided vault changes in the background while unlocked. Off by default. */
  autoPull: boolean
  /** Save the local .env as .env.bak.<timestamp> before a pull replaces it. */
  backups: boolean
  /** How many of those backups to keep per repo; older ones are deleted on the next backup. */
  backupCount: number
  /** Let the envvault command check status and push (see src/main/cliserver.ts). */
  cliAccess: boolean
  /** Keep the mini window above other windows. */
  miniOnTop: boolean
  /**
   * Folders this machine syncs under another name in the vault, by folder id
   * (lowercased name). Set with repo:setVaultName, never settings:save.
   */
  repoNames: Record<string, string>
}

/**
 * The window's layout: the full app, or mini mode on one repo (src/main/mini.ts).
 * `reviewing` makes the mini window big enough for the push or pull dialog.
 */
export type Layout =
  { layout: 'full' } | { layout: 'mini'; repoName: string; path: string; reviewing: boolean }

/** The GitHub CLI, as Setup sees it (see src/main/gh.ts). */
export interface GhStatus {
  /** gh is installed. */
  available: boolean
  signedIn: boolean
  login: string | null
  /** gh's git_protocol for github.com, which the clone URLs it gives use. */
  protocol: 'ssh' | 'https'
}

/** A private GitHub repository that could hold the vault. */
export interface GitRepoChoice {
  /** owner/name */
  name: string
  /** The clone URL, for settings:setGitVault. */
  url: string
  isEmpty: boolean
  /** ISO 8601. */
  updatedAt: string
}

/** The Claude Code skill EnvVault installs (see src/main/skill.ts). */
export interface SkillInfo {
  /**
   * - missing: no SKILL.md there
   * - current: exactly what this app would write
   * - different: written by another version or location of the app, or edited
   */
  state: 'missing' | 'current' | 'different'
  /** Where the skill lives, for display. */
  path: string
}

/**
 * - not-configured: no vault folder chosen yet
 * - folder-missing: chosen folder doesn't exist (Drive not running?)
 * - empty: folder exists with no vault in it, so a vault can be created
 * - meta-missing: entries exist but meta.json doesn't, so creating is refused
 * - ready: meta.json exists, so the vault can be unlocked
 */
export type VaultFolderState =
  'not-configured' | 'folder-missing' | 'empty' | 'meta-missing' | 'ready'

/**
 * Whether this machine can unlock the vault without its setup code:
 * - not-used: a format 1 vault (password only)
 * - saved: format 2, and this machine has the secret
 * - needed: format 2, and the setup code must be entered with the password
 */
export type SetupCodeState = 'not-used' | 'saved' | 'needed'

export interface AppState {
  configured: boolean
  vault: VaultFolderState
  /** Set when `vault` is ready and meta.json could be read. */
  setupCode: SetupCodeState | null
  locked: boolean
}

/**
 * - excluded: a vault copy of a file the repo's rules don't sync (only removing it is offered)
 */
export type RowStatus = SyncStatus | 'error' | 'excluded'

/** One env file of one repo (see EnvFile). Match rows with sameFile (src/shared/envfile.ts). */
export interface RepoRow {
  /** The repo: its folder in the projects folder, or its vault name if it is only in the vault. */
  name: string
  /** The repo is a folder in the projects folder (false: only in the vault). */
  local: boolean
  /** The name its env files are under in the vault (see RepoInfo.vaultName). */
  vaultName: string
  /**
   * The file's path in the repo. Null only for a vault entry that couldn't be
   * read, whose path is inside its ciphertext (see `storedName`).
   */
  path: string | null
  /** The file's name in the vault (folder or repository), or null if it has no vault copy. */
  storedName: string | null
  status: RowStatus
  hasEnv: boolean
  vault: VaultInfo | null
  error: AppErrorInfo | null
}

/** One repo, in the projects folder or only in the vault. */
export interface RepoInfo {
  /** Its folder, or its vault name if it is only in the vault: its rows' `name`. */
  name: string
  local: boolean
  /**
   * The name its env files are under in the vault: the folder's own, unless
   * this machine syncs it as another (Settings.repoNames).
   */
  vaultName: string
  ignored: boolean
  /** The env files git found in it at the last rescan, whatever its rules; null if unknown. */
  found: string[] | null
  /** How many env files the vault has under its vault name. */
  copies: number
}

/** The repo settings in the vault, as the list read them. */
export interface RepoSettingsView {
  defaults: FileRules
  /** Each repo's own settings, by vault id (its lowercased vault name). */
  repos: Record<string, RepoRules>
  /** Set if the vault's settings couldn't be read: the built-in ones are in use. */
  error: AppErrorInfo | null
}

export interface RepoList {
  /** One per env file of every repo that isn't ignored. */
  rows: RepoRow[]
  /** Every repo: the projects folder's, then those only in the vault. */
  repos: RepoInfo[]
  settings: RepoSettingsView
}

/** Save a repo's settings, by its vault name (for every machine that syncs it). */
export interface RepoSettingsRequest extends RepoRules {
  vaultName: string
}

/** Sync a folder (`repoName`) as another name in the vault; its own name stops that. */
export interface VaultNameRequest {
  repoName: string
  vaultName: string
}

/** The content the user reviewed; push/pull refuse if it has changed since. */
export interface Expected {
  localHash: string | null
  vaultHash: string | null
}

/** How a .env compares with the repo's .env.example. Key names only. */
export interface ExampleDiff {
  /** Secret-looking values that are identical in both files. */
  sameValue: string[]
  /** Keys the example assigns that the .env doesn't. */
  missing: string[]
  /** Keys the .env assigns that the example doesn't. */
  undocumented: string[]
}

export type ExampleCheck =
  | ({
      status: 'ok'
      /** .env.example is tracked by git; null if unknown. */
      tracked: boolean | null
    } & ExampleDiff)
  | { status: 'unreadable'; message: string }

export interface PushPreview {
  diff: DiffResult
  needsOverwrite: boolean
  vault: VaultInfo | null
  /** Local and vault bytes are identical: nothing to push. */
  sameContent: boolean
  /** Machine-specific keys (`# envvault:local`): their values are not uploaded. */
  kept: string[]
  /**
   * Keys the vault marks machine-specific that the local .env has without a
   * marker: their values would be uploaded.
   */
  unmarked: string[]
  /** The local .env against .env.example; null if there is none or the check is off. */
  example: ExampleCheck | null
  expected: Expected
}

export interface PullPreview {
  diff: DiffResult
  vault: VaultInfo
  hasLocal: boolean
  ignored: boolean
  /** Backup and temp files (.env.bak.*) would be ignored too. */
  backupIgnored: boolean
  tracked: boolean
  /** The vault version is lower than the one last synced here. */
  rollback: boolean
  /** Pulling would leave the local .env as it is. */
  sameContent: boolean
  /** Machine-specific keys whose local values the pull keeps. */
  kept: string[]
  /** Machine-specific keys this machine has no value for: written empty. */
  unset: string[]
  /** The pulled result against .env.example; null if there is none or the check is off. */
  example: ExampleCheck | null
  expected: Expected
}

export interface PushRequest extends EnvFile {
  overwriteConfirmed: boolean
  expected: Expected
}

export interface PullRequest extends EnvFile {
  expected: Expected
}

/**
 * Remove an env file's vault copy, if it is still the one the user saw. By
 * its vault name: the repo may be only in the vault.
 */
export interface RemoveRequest {
  vaultName: string
  path: string
  expectedVaultHash: string
}

export interface RawDiffRequest extends PullRequest {
  /** Return the lines as they are instead of masked. */
  values: boolean
}

export interface PullResult {
  backupName: string | null
}

export interface GitignoreResult {
  ignored: boolean
  /** Backup and temp files (.env.bak.*) would be ignored too. */
  backupIgnored: boolean
  tracked: boolean
}
