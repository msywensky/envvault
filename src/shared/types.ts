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

/** Local .env -> vault copy. Empty when no line changes (line endings only). */
export interface RawDiff {
  lines: RawDiffLine[]
}

export interface Settings {
  projectsPath: string | null
  vaultPath: string | null
  autoLockMinutes: number
  machineName: string
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

export interface PushPreview {
  diff: DiffResult
  needsOverwrite: boolean
  vault: VaultInfo | null
  /** Local and vault bytes are identical: nothing to push. */
  sameContent: boolean
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
  sameContent: boolean
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
