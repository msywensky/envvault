// Text shown by both main (system notifications) and the renderer (toasts).
// Relative imports only, like the rest of src/shared.
import type { RepoRow } from './types'

/** "Pulled webapp's .env (v4) from the vault." for automatic pulls. */
export function autoPullMessage(rows: Pick<RepoRow, 'name' | 'vault'>[]): string {
  const [only] = rows
  if (rows.length === 1 && only) {
    return `Pulled ${only.name}'s .env (v${only.vault?.version ?? '?'}) from the vault.`
  }
  return `Pulled ${rows.length} .env files from the vault: ${rows.map((r) => r.name).join(', ')}.`
}
