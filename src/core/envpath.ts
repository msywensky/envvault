// Env files inside a repo, named by their path from the repo root: ".env",
// "apps/web/.env". Paths use "/" on every platform, as git prints them, and
// are ASCII-only like repo names, so they need no normalisation. A valid path
// never leaves its repo: no "." or ".." segments, no ".git", and nothing
// Windows would read as another name (a trailing dot, a device name).
import { isWindowsReserved } from './paths'

/** Every repo's own .env, at its root. */
export const ROOT_ENV = '.env'

/** The file names that are synced, in any folder. */
export const ENV_FILE_NAMES: readonly string[] = [ROOT_ENV]

/** At most this many folders between the repo root and the file. */
export const MAX_ENV_FOLDERS = 8
const MAX_ENV_PATH = 255

const FOLDER_RE = /^[A-Za-z0-9._@+-]{1,100}$/

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
    ENV_FILE_NAMES.includes(file) &&
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
