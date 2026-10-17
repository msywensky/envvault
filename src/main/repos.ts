// Finds repos in the projects folder and reads their .env files. Repo names
// always pass isValidRepoName, and every path is checked to stay inside the
// projects folder after resolving symlinks.
import { constants } from 'node:fs'
import { lstat, open, readdir, realpath, stat } from 'node:fs/promises'
import { isInside, isValidRepoName, resolveInside } from '../core/paths'
import { sha256Hex } from '../core/crypto'
import { AppError } from './errors'
import { isErrno } from './fsutil'
import { syncedBytes } from './localkeys'

const MAX_ENV_BYTES = 1024 * 1024

export interface ScannedRepo {
  name: string
  dir: string
  /** sha256 of syncedBytes(.env), or null if there is no .env. */
  localHash: string | null
  /** Set when the .env exists but can't be used (symlink, too large, ...). */
  envError: AppError | null
}

async function projectsRoot(projectsPath: string): Promise<string> {
  try {
    return await realpath(projectsPath)
  } catch (err) {
    if (isErrno(err, 'ENOENT', 'ENOTDIR')) {
      throw new AppError('PROJECTS_FOLDER_MISSING', 'The projects folder was not found.')
    }
    throw err
  }
}

/** Resolve a repo folder by name, or null if it isn't a usable git repo. */
async function findRepo(root: string, name: string): Promise<string | null> {
  if (!isValidRepoName(name)) return null
  try {
    const dir = await realpath(resolveInside(root, name))
    // A symlinked repo folder must still point inside the projects folder.
    if (!isInside(root, dir)) return null
    // .git is a directory, or a file for worktrees and submodules.
    await stat(resolveInside(dir, '.git'))
    return dir
  } catch {
    return null
  }
}

/** The repo folder for `name`, or REPO_NOT_FOUND. */
export async function resolveRepo(projectsPath: string, name: string): Promise<string> {
  const dir = await findRepo(await projectsRoot(projectsPath), name)
  if (!dir) {
    throw new AppError(
      'REPO_NOT_FOUND',
      `"${name}" is not a git repository in the projects folder.`
    )
  }
  return dir
}

/**
 * Exact bytes of the repo's .env, or null if there is none. Refuses
 * symlinks: lstat rejects them up front, O_NOFOLLOW (macOS/Linux) and an
 * identity check on the opened handle close the window where the file could
 * be swapped for a symlink between the check and the read.
 */
export async function readLocalEnv(repoDir: string): Promise<Buffer | null> {
  const file = resolveInside(repoDir, '.env')
  let info
  try {
    info = await lstat(file)
  } catch (err) {
    if (isErrno(err, 'ENOENT')) return null
    throw err
  }
  if (info.isSymbolicLink()) {
    throw new AppError('ENV_SYMLINK', '.env is a symlink, which EnvVault refuses to follow.')
  }
  if (!info.isFile()) throw new AppError('ENV_NOT_FILE', '.env is not a regular file.')
  if (info.size > MAX_ENV_BYTES) throw new AppError('ENV_TOO_LARGE', '.env is larger than 1 MiB.')

  let fh
  try {
    fh = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  } catch (err) {
    if (isErrno(err, 'ELOOP')) {
      throw new AppError('ENV_SYMLINK', '.env is a symlink, which EnvVault refuses to follow.')
    }
    throw err
  }
  try {
    const opened = await fh.stat()
    if (!opened.isFile() || opened.ino !== info.ino || opened.dev !== info.dev) {
      throw new AppError('ENV_NOT_FILE', '.env changed while it was being read. Try again.')
    }
    if (opened.size > MAX_ENV_BYTES)
      throw new AppError('ENV_TOO_LARGE', '.env is larger than 1 MiB.')
    return await fh.readFile()
  } finally {
    await fh.close()
  }
}

function syncedHash(env: Buffer): string {
  const synced = syncedBytes(env)
  try {
    return sha256Hex(synced)
  } finally {
    if (synced !== env) synced.fill(0)
  }
}

export async function scanRepos(projectsPath: string): Promise<ScannedRepo[]> {
  const root = await projectsRoot(projectsPath)
  const entries = await readdir(root, { withFileTypes: true })
  const scanned = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map(async (entry): Promise<ScannedRepo | null> => {
        const dir = await findRepo(root, entry.name)
        if (!dir) return null
        try {
          const env = await readLocalEnv(dir)
          try {
            return {
              name: entry.name,
              dir,
              localHash: env ? syncedHash(env) : null,
              envError: null
            }
          } finally {
            env?.fill(0)
          }
        } catch (err) {
          if (!(err instanceof AppError)) throw err
          return { name: entry.name, dir, localHash: null, envError: err }
        }
      })
  )
  return scanned.filter((r): r is ScannedRepo => r !== null)
}
