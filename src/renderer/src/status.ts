import { ROOT_ENV } from '../../shared/envfile'
import type { EnvFile, RepoRow } from '../../shared/types'

export type RowStatus = RepoRow['status']

/**
 * The env file a row is about, as a plain object IPC can clone. Only rows
 * with actions get here, and those always have a path: a row without one is
 * a vault entry that couldn't be read.
 */
export function fileOf(row: Pick<RepoRow, 'name' | 'path'>): EnvFile {
  if (row.path === null) throw new Error('This row has no env file.')
  return { repoName: row.name, path: row.path }
}

/** A key for v-for and :key, unique per repo: a folder, or a repo only in the vault. */
export const repoKey = (repo: Pick<RepoRow, 'name' | 'local'>): string =>
  `${repo.local ? 'folder' : 'vault'}\n${repo.name.toLowerCase()}`

/** A key for v-for and :key, unique per env file (see sameFile). */
export const rowKey = (row: RepoRow): string =>
  `${repoKey(row)}\n${row.path?.toLowerCase() ?? row.storedName ?? ''}`

/** How a file is named in titles and toasts: "webapp", or "platform/apps/web/.env". */
export function fileTitle(row: Pick<RepoRow, 'name' | 'path'>): string {
  return row.path === null || row.path === ROOT_ENV ? row.name : `${row.name}/${row.path}`
}

/**
 * An env file found in a folder of a repo that nobody has pushed yet: listed
 * quietly, apart from the files that sync, and never counted as needing
 * attention. A file at the repo's root (.env, .env.local) is never quiet.
 */
export const isQuiet = (row: RepoRow): boolean =>
  row.path !== null && row.path.includes('/') && row.status === 'local-only'
export type RowAction = 'push' | 'pull' | 'keep-local' | 'keep-vault'

export const STATUS_LABEL: Record<RowStatus, string> = {
  'in-sync': 'In sync',
  'local-newer': 'Local newer',
  'vault-newer': 'Vault newer',
  'local-only': 'Local only',
  'vault-only': 'Vault only',
  'no-env': 'No .env',
  conflict: 'Conflict',
  error: 'Error',
  excluded: 'Excluded'
}

export const STATUS_HINT: Record<RowStatus, string> = {
  'in-sync': 'Local .env and the vault copy are identical.',
  'local-newer': 'You changed the local .env since the last sync.',
  'vault-newer': 'Another machine pushed a newer version.',
  'local-only': 'This .env has never been pushed to the vault.',
  'vault-only': 'In the vault, but this repo is not in your projects folder.',
  'no-env': 'No .env here and none in the vault.',
  conflict: 'Both sides changed, or they differ and were never synced here.',
  error: 'Something is wrong with this repo or its vault copy.',
  excluded:
    "In the vault, but this repo's settings don't sync it. Remove the vault copy, or change the settings."
}

/** Which buttons a row offers (see the status table in the README). */
export function actionsFor(row: RepoRow): RowAction[] {
  switch (row.status) {
    case 'local-only':
    case 'local-newer':
      return ['push']
    case 'vault-newer':
      return ['pull']
    case 'conflict':
      return row.hasEnv ? ['keep-local', 'keep-vault'] : ['keep-vault']
    default:
      return []
  }
}

/**
 * Rows whose vault copy can be edited: the repo is in the projects folder and
 * isn't local-only (push that instead). A No .env row starts an empty copy.
 */
export function canEdit(row: RepoRow): boolean {
  return ['in-sync', 'local-newer', 'vault-newer', 'conflict', 'no-env'].includes(row.status)
}

/** Same rule as core's KEY_RE (src/core/envdiff.ts) and main's EnvKey schema. */
export function envKeyProblem(key: string): string | null {
  if (key === '') return 'Enter a key name.'
  if (key.length > 200) return 'Use at most 200 characters.'
  if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key)) {
    return 'Use letters, digits, _ . or -, starting with a letter or _.'
  }
  return null
}

export const ACTION_LABEL: Record<RowAction, string> = {
  push: 'Push',
  pull: 'Pull',
  'keep-local': 'Keep local',
  'keep-vault': 'Keep vault'
}

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })

/** "3 minutes ago", falling back to a date for anything older than a week. */
export function relativeTime(iso: string, now = Date.now()): string {
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return iso
  const seconds = Math.round((then - now) / 1000)
  const abs = Math.abs(seconds)
  if (abs < 60) return rtf.format(seconds, 'second')
  if (abs < 3600) return rtf.format(Math.round(seconds / 60), 'minute')
  if (abs < 86400) return rtf.format(Math.round(seconds / 3600), 'hour')
  if (abs < 7 * 86400) return rtf.format(Math.round(seconds / 86400), 'day')
  return new Date(then).toLocaleDateString()
}

export const absoluteTime = (iso: string): string => new Date(iso).toLocaleString()

/** Last segment of a folder path, for compact display (full path in a title). */
export function folderName(path: string | null | undefined): string {
  if (!path) return ''
  return (
    path
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() ?? path
  )
}

/** Same rule as main's MachineName schema: 1-64 chars after trimming, no control chars. */
export function machineNameProblem(name: string): string | null {
  const trimmed = name.trim()
  if (trimmed === '') return 'Enter a name for this machine.'
  if (trimmed.length > 64) return 'Use at most 64 characters.'
  if (/\p{Cc}/u.test(trimmed)) return 'Remove control characters.'
  return null
}
