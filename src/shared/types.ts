// Plain data types shared by main, core and the renderer. Type-only, so the
// renderer can import them without pulling in node code. None of these carry
// env values, except a RawDiff requested with `values: true` (see
// sync.pullRawDiff).
import type { AppErrorInfo } from './result'

export type SyncStatus =
  'vault-only' | 'no-env' | 'local-only' | 'vault-newer' | 'in-sync' | 'local-newer' | 'conflict'

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

export interface SaveEditRequest {
  repoName: string
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

export interface Settings {
  projectsPath: string | null
  vaultPath: string | null
  autoLockMinutes: number
  machineName: string
  /** Compare .env with .env.example in the push and pull dialogs. */
  checkExample: boolean
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

export interface AppState {
  configured: boolean
  vault: VaultFolderState
  locked: boolean
}

export interface RepoRow {
  name: string
  status: SyncStatus | 'error'
  hasEnv: boolean
  vault: VaultInfo | null
  error: AppErrorInfo | null
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

export interface PushRequest {
  repoName: string
  overwriteConfirmed: boolean
  expected: Expected
}

export interface PullRequest {
  repoName: string
  expected: Expected
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
