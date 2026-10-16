import type { RepoRow } from '../../shared/types'

export type RowStatus = RepoRow['status']
export type RowAction = 'push' | 'pull' | 'keep-local' | 'keep-vault'

export const STATUS_LABEL: Record<RowStatus, string> = {
  'in-sync': 'In sync',
  'local-newer': 'Local newer',
  'vault-newer': 'Vault newer',
  'local-only': 'Local only',
  'vault-only': 'Vault only',
  'no-env': 'No .env',
  conflict: 'Conflict',
  error: 'Error'
}

export const STATUS_HINT: Record<RowStatus, string> = {
  'in-sync': 'Local .env and the vault copy are identical.',
  'local-newer': 'You changed the local .env since the last sync.',
  'vault-newer': 'Another machine pushed a newer version.',
  'local-only': 'This .env has never been pushed to the vault.',
  'vault-only': 'In the vault, but this repo is not in your projects folder.',
  'no-env': 'No .env here and none in the vault.',
  conflict: 'Both sides changed, or they differ and were never synced here.',
  error: 'Something is wrong with this repo or its vault copy.'
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
