// Env files in rows and requests (EnvFile, RepoRow in ./types). Relative
// imports only, like the rest of src/shared; the rules for a valid path are in
// src/core/envpath.ts.
import type { RepoRow } from './types'

/** Every repo's own .env, at its root. */
export const ROOT_ENV = '.env'

type FileOf = Pick<RepoRow, 'name' | 'path' | 'storedName'>

/**
 * True if two rows, or a row and a file, are the same env file: compared
 * case-insensitively, like the vault's entry ids. A row without a path (an
 * unreadable vault entry) is only ever the same as itself.
 */
export function sameFile(a: FileOf, b: FileOf): boolean {
  if (a.name.toLowerCase() !== b.name.toLowerCase()) return false
  if (a.path === null || b.path === null) return a.path === b.path && a.storedName === b.storedName
  return a.path.toLowerCase() === b.path.toLowerCase()
}

/** "webapp's .env", or "platform/apps/web/.env" for one in a subfolder. */
export function envLabel(file: Pick<RepoRow, 'name' | 'path'>): string {
  if (file.path === null) return `an env file in ${file.name}`
  return file.path === ROOT_ENV ? `${file.name}'s .env` : `${file.name}/${file.path}`
}
