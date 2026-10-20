// Env files inside a repo, named by their path from the repo root: ".env",
// "apps/web/.env.local". Paths use "/" on every platform, as git prints them,
// and are ASCII-only like repo names, so they need no normalisation. A valid
// path never leaves its repo: no "." or ".." segments, no ".git", and nothing
// Windows would read as another name (a trailing dot, a device name). Which
// of these a repo actually syncs is up to its rules (src/shared/envrules.ts).
import { ROOT_ENV } from '../shared/envfile'
import { isReservedEnvName } from '../shared/envrules'
import { isWindowsReserved } from './paths'

export { ROOT_ENV }

/** At most this many folders between the repo root and the file. */
export const MAX_ENV_FOLDERS = 8
const MAX_ENV_PATH = 255
const MAX_ENV_NAME = 100

const FOLDER_RE = /^[A-Za-z0-9._@+-]{1,100}$/
// .env, or .env.<suffix> with dot-separated parts: .env.local, .env.production.local.
const ENV_NAME_RE = /^\.env(?:\.[A-Za-z0-9_-]+)*$/

/** True for a file name EnvVault can sync: .env or .env.<suffix>, except reserved names. */
export function isEnvFileName(name: string): boolean {
  return name.length <= MAX_ENV_NAME && ENV_NAME_RE.test(name) && !isReservedEnvName(name)
}

function isFolderName(name: string): boolean {
  return (
    FOLDER_RE.test(name) &&
    name !== '.' &&
    name !== '..' &&
    !name.endsWith('.') &&
    name.toLowerCase() !== '.git' &&
    !isWindowsReserved(name)
  )
}

/** True if `path` names an env file inside a repo (see the top of this file). */
export function isEnvPath(path: string): boolean {
  if (path.length > MAX_ENV_PATH) return false
  const parts = path.split('/')
  const file = parts.pop()
  return (
    file !== undefined &&
    isEnvFileName(file) &&
    parts.length <= MAX_ENV_FOLDERS &&
    parts.every(isFolderName)
  )
}

/** The folders from the repo root down to the file: [] for the root .env. */
export function envFolders(path: string): string[] {
  return path.split('/').slice(0, -1)
}

/** The file's own name, without its folders. */
export function envFileName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

/** How paths are compared, and named in the vault: case-insensitively, like the filesystems. */
export const envPathId = (path: string): string => path.toLowerCase()

// A backup's timestamp (see backupStamp in main/sync.ts), with -<4 hex> if
// that name was taken.
const STAMP_RE = /^\d{8}T\d{6}Z(?:-[0-9a-f]{4})?$/

/**
 * What a pull backs up the env file `fileName` as: .env.bak.<stamp> for .env,
 * .env.bak.local.<stamp> for .env.local. Always .env.bak.*, so the one ignore
 * line covers them all, and reserved (isEnvFileName), so they never sync.
 */
export function backupName(fileName: string, stamp: string): string {
  return fileName === ROOT_ENV ? `.env.bak.${stamp}` : `.env.bak.${fileName.slice(5)}.${stamp}`
}

/** True if `name` is one of `fileName`'s backups (and nobody else's, or a temp file). */
export function isBackupOf(fileName: string, name: string): boolean {
  const prefix = backupName(fileName, '')
  return name.startsWith(prefix) && STAMP_RE.test(name.slice(prefix.length))
}
