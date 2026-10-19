// Text shown by main (system notifications) and the renderer (toasts).
// Relative imports only, like the rest of src/shared.
import { ROOT_ENV, envLabel } from './envfile'
import type { RepoRow } from './types'

type Pulled = Pick<RepoRow, 'name' | 'path' | 'vault'>

/** "Pulled webapp's .env (v4) from the vault." for automatic pulls. */
export function autoPullMessage(rows: Pulled[]): string {
  const [only] = rows
  if (rows.length === 1 && only) {
    return `Pulled ${envLabel(only)} (v${only.vault?.version ?? '?'}) from the vault.`
  }
  const names = rows.map((r) => (r.path === ROOT_ENV ? r.name : `${r.name}/${r.path}`))
  return `Pulled ${rows.length} .env files from the vault: ${names.join(', ')}.`
}

/** "Pushed webapp's .env (v5) from the command line." */
export function cliPushMessage(row: Pulled): string {
  return `Pushed ${envLabel(row)} (v${row.vault?.version ?? '?'}) from the command line.`
}
