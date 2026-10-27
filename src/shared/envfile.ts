// Env files in rows and requests (EnvFile, RepoRow in ./types). Relative
// imports only, like the rest of src/shared; the rules for a valid path are in
// src/core/envpath.ts.
import type { RepoRow } from './types'

/** Every repo's own .env, at its root. */
export const ROOT_ENV = '.env'

/** The file's own name, without its folders. */
export function envFileName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

/**
 * What a pull backs up the env file `fileName` as: .env.bak.<stamp> for .env,
 * .env.bak.local.<stamp> for .env.local, .env.bak.@secrets.env.<stamp> for
 * another name (no .env.<suffix> has an "@", so the two never meet). Always
 * .env.bak.*, so the one ignore line covers them all, and reserved
 * (isEnvFileName in src/core/envpath.ts), so they never sync.
 */
export function backupName(fileName: string, stamp: string): string {
  if (fileName === ROOT_ENV) return `.env.bak.${stamp}`
  return /^\.env(?:\.|$)/i.test(fileName)
    ? `.env.bak.${fileName.slice(5)}.${stamp}`
    : `.env.bak.@${fileName}.${stamp}`
}

type FileOf = Pick<RepoRow, 'name' | 'local' | 'path' | 'storedName'>

/**
 * True if two rows, or a row and a file, are the same env file: compared
 * case-insensitively, like the vault's entry ids. A folder and a repo only in
 * the vault are never the same, even by name (the folder can sync as another
 * name). A row without a path (an unreadable vault entry) is only ever the
 * same as itself.
 */
export function sameFile(a: FileOf, b: FileOf): boolean {
  if (a.local !== b.local || a.name.toLowerCase() !== b.name.toLowerCase()) return false
  if (a.path === null || b.path === null) return a.path === b.path && a.storedName === b.storedName
  return a.path.toLowerCase() === b.path.toLowerCase()
}

/** "webapp's .env", or "platform/apps/web/.env" for one in a subfolder. */
export function envLabel(file: Pick<RepoRow, 'name' | 'path'>): string {
  if (file.path === null) return `an env file in ${file.name}`
  return file.path === ROOT_ENV ? `${file.name}'s .env` : `${file.name}/${file.path}`
}
