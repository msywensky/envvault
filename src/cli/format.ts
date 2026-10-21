// Text output for the envvault command, and the --expect token.
import { ROOT_ENV, envLabel } from '../shared/envfile'
import type { Expected, PushPreview, RepoRow, RowStatus, VaultInfo } from '../shared/types'

/** A file as the command names it: "web" for a repo's root .env, else "platform/apps/web/.env". */
export function fileLabel(name: string, path: string | null, storedName?: string | null): string {
  return path === ROOT_ENV ? name : `${name}/${path ?? storedName ?? 'an unreadable vault copy'}`
}

const STATUS: Record<Exclude<RowStatus, 'error'>, string> = {
  'in-sync': 'in sync',
  'local-newer': 'local newer: push to update the vault',
  'local-only': 'local only: push to add it to the vault',
  'vault-newer': 'vault newer: another machine pushed',
  'both-changed': 'both changed: merge it in EnvVault',
  conflict: 'conflict: resolve it in EnvVault',
  'vault-only': 'vault only: its repo or folder is not in your projects folder',
  'no-env': 'no .env here or in the vault',
  excluded: "excluded by the repo's settings: remove its vault copy in EnvVault"
}

const HASH = '[0-9a-f]{64}'
const EXPECT_RE = new RegExp(`^(${HASH}|none)\\.(${HASH}|none)$`)

/** The preview's `expected` as one token: `<localHash>.<vaultHash>`, `none` for null. */
export function encodeExpect(expected: Expected): string {
  return `${expected.localHash ?? 'none'}.${expected.vaultHash ?? 'none'}`
}

export function decodeExpect(token: string): Expected | null {
  const m = EXPECT_RE.exec(token)
  if (!m || m[1] === undefined || m[2] === undefined) return null
  const hash = (s: string): string | null => (s === 'none' ? null : s)
  return { localHash: hash(m[1]), vaultHash: hash(m[2]) }
}

const pad = (n: number): string => String(n).padStart(2, '0')

function when(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const vaultLine = (v: VaultInfo): string =>
  `vault v${v.version}, by ${v.updatedBy}, ${when(v.updatedAt)}`

/** A row's file, and the name its folder syncs as if that's another. */
function rowLabel(r: RepoRow): string {
  const label = fileLabel(r.name, r.path, r.storedName)
  return r.local && r.vaultName.toLowerCase() !== r.name.toLowerCase()
    ? `${label} (as ${r.vaultName})`
    : label
}

export function formatRows(rows: RepoRow[]): string {
  const labels = rows.map(rowLabel)
  const width = Math.max(0, ...labels.map((label) => label.length))
  return rows
    .map((r, i) => {
      const status =
        r.status === 'error' ? `error: ${r.error?.message ?? 'unknown'}` : STATUS[r.status]
      const vault = r.vault ? ` (${vaultLine(r.vault)})` : ''
      return `${(labels[i] ?? r.name).padEnd(width)}  ${status}${vault}\n`
    })
    .join('')
}

const list = (keys: string[]): string => keys.join(', ')

/** `status`: the rows, then the repos EnvVault leaves alone. */
export function formatStatus(rows: RepoRow[], ignored: string[]): string {
  const left = ignored.length ? `Ignored in EnvVault: ${list(ignored)}\n` : ''
  return formatRows(rows) + left
}

export function formatPreview(repo: string, p: PushPreview): string {
  if (p.sameContent) {
    return `${repo}: already in sync${p.vault ? ` (vault v${p.vault.version})` : ''}\n`
  }
  const lines = [
    p.vault
      ? `${repo}: push to the vault as v${p.vault.version + 1} (now ${vaultLine(p.vault)})`
      : `${repo}: push to the vault as v1 (not in the vault yet)`
  ]
  const { added, removed, changed, unchanged } = p.diff
  if (added.length) lines.push(`  added:     ${list(added)}`)
  if (removed.length) lines.push(`  removed:   ${list(removed)}`)
  if (changed.length) lines.push(`  changed:   ${list(changed)}`)
  if (!added.length && !removed.length && !changed.length) {
    lines.push('  no key changes (only comments or formatting)')
  }
  if (unchanged) lines.push(`  unchanged: ${unchanged} ${unchanged === 1 ? 'key' : 'keys'}`)
  if (p.kept.length) lines.push(`  machine-specific, value kept here: ${list(p.kept)}`)
  if (p.unmarked.length) {
    lines.push(
      `  warning: the vault marks ${list(p.unmarked)} machine-specific but your .env doesn't, so ${p.unmarked.length === 1 ? 'its value' : 'their values'} would be uploaded`
    )
  }
  const ex = p.example
  if (ex?.status === 'unreadable') lines.push(`  .env.example: ${ex.message}`)
  if (ex?.status === 'ok') {
    if (ex.missing.length)
      lines.push(`  .env.example lists keys your .env lacks: ${list(ex.missing)}`)
    if (ex.undocumented.length) {
      lines.push(`  .env.example doesn't document: ${list(ex.undocumented)}`)
    }
    if (ex.sameValue.length) {
      lines.push(`  warning: same secret-looking value in .env.example: ${list(ex.sameValue)}`)
    }
  }
  if (p.needsOverwrite) {
    lines.push('The vault copy changed on another machine. Resolve it in EnvVault.')
  }
  return `${lines.join('\n')}\n`
}

/** After a push: `unchanged` if the vault copy was already this content. */
export function formatPushed(row: RepoRow, unchanged: boolean): string {
  const version = row.vault ? ` (v${row.vault.version})` : ''
  return unchanged
    ? `${fileLabel(row.name, row.path, row.storedName)} is already in sync${version}.\n`
    : `Pushed ${envLabel(row)} to the vault${version}.\n`
}
