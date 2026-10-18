// Finds repos in the projects folder and reads their .env files. Repo names
// always pass isValidRepoName, and every path is checked to stay inside the
// projects folder after resolving symlinks.
import { constants } from 'node:fs'
import { lstat, open, readdir, realpath, stat } from 'node:fs/promises'
import { relative, sep } from 'node:path'
import { isInside, isValidRepoName, resolveInside } from '../core/paths'
import { sha256Hex } from '../core/crypto'
import { AppError } from './errors'
import { isErrno } from './fsutil'
import { syncedBytes } from './localkeys'

export const MAX_ENV_BYTES = 1024 * 1024

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
 * The name of the repo that contains `dir`, the envvault command's working
 * directory. The path is used only to work out the name.
 */
export async function repoNameAt(projectsPath: string, dir: string): Promise<string> {
  const root = await projectsRoot(projectsPath)
  const notFound = (): AppError =>
    new AppError(
      'REPO_NOT_FOUND',
      'Run this inside a repo in your projects folder, or pass --repo.'
    )
  let real: string
  try {
    real = await realpath(dir)
  } catch {
    throw notFound()
  }
  if (!isInside(root, real)) throw notFound()
  const [name] = relative(root, real).split(sep)
  if (!name || !(await findRepo(root, name))) throw notFound()
  return name
}

/**
 * Exact bytes of the file `name` in the repo folder, or null if there is
 * none. Refuses symlinks: lstat rejects them up front, O_NOFOLLOW
 * (macOS/Linux) and an identity check on the opened handle close the window
 * where the file could be swapped for a symlink between the check and the
 * read.
 */
export async function readRepoFile(repoDir: string, name: string): Promise<Buffer | null> {
  const file = resolveInside(repoDir, name)
  const symlink = (): AppError =>
    new AppError('ENV_SYMLINK', `${name} is a symlink, which EnvVault refuses to follow.`)
  const tooLarge = (): AppError => new AppError('ENV_TOO_LARGE', `${name} is larger than 1 MiB.`)
  let info
  try {
    info = await lstat(file)
  } catch (err) {
    if (isErrno(err, 'ENOENT')) return null
    throw err
  }
  if (info.isSymbolicLink()) throw symlink()
  if (!info.isFile()) throw new AppError('ENV_NOT_FILE', `${name} is not a regular file.`)
  if (info.size > MAX_ENV_BYTES) throw tooLarge()

  let fh
  try {
    fh = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  } catch (err) {
    if (isErrno(err, 'ELOOP')) throw symlink()
    throw err
  }
  try {
    const opened = await fh.stat()
    if (!opened.isFile() || opened.ino !== info.ino || opened.dev !== info.dev) {
      throw new AppError('ENV_NOT_FILE', `${name} changed while it was being read. Try again.`)
    }
    if (opened.size > MAX_ENV_BYTES) throw tooLarge()
    return await fh.readFile()
  } finally {
    await fh.close()
  }
}

/** Exact bytes of the repo's .env, or null if there is none (see readRepoFile). */
export function readLocalEnv(repoDir: string): Promise<Buffer | null> {
  return readRepoFile(repoDir, '.env')
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
