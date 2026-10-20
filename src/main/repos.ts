// Finds repos in the projects folder and reads their env files. Repo names
// always pass isValidRepoName and env file paths isEnvPath. Every path is
// checked to stay inside the projects folder: a repo folder after resolving
// symlinks, and an env file by refusing a symlink anywhere below its repo.
import { constants } from 'node:fs'
import { lstat, open, readdir, realpath, stat } from 'node:fs/promises'
import { relative, sep } from 'node:path'
import { ROOT_ENV, envFileName, envFolders, isEnvPath } from '../core/envpath'
import { isInside, isValidRepoName, resolveInside } from '../core/paths'
import { sha256Hex } from '../core/crypto'
import { isIncluded, type FileRules } from '../shared/envrules'
import { AppError } from './errors'
import { isErrno } from './fsutil'
import { findEnvFiles } from './git'
import { syncedBytes } from './localkeys'
import { createLimit } from './mutex'

export const MAX_ENV_BYTES = 1024 * 1024
/** Env files remembered per repo from what git finds, whatever its rules. */
const MAX_FOUND = 200
/** Env files listed per repo from what git found, after its rules. */
const MAX_FILES = 50
/** Repos asked for their env files at once (three git processes each). */
const FINDING_AT_ONCE = 8

/** One env file of a scanned repo, as it is on disk now. */
export interface ScannedFile {
  path: string
  /** The file's folder exists (always true for the root .env). */
  folderExists: boolean
  /** sha256 of syncedBytes(file), or null if there is none. */
  localHash: string | null
  /** Set when the file exists but can't be used (symlink, too large, ...). */
  envError: AppError | null
}

/** A repo folder in the projects folder. */
export interface RepoFolder {
  name: string
  dir: string
}

export interface ScannedRepo extends RepoFolder {
  /** Its root .env first if its rules include it, then the other env files they include. */
  files: ScannedFile[]
  /** What git found in it at the last rescan, whatever the rules; null if unknown. */
  found: string[] | null
}

// What git found in each repo (by folder) when last asked, so background
// work never runs git in every repo: every env file, whatever the repo's
// rules, so that a change of rules needs no rescan. Lost on restart; refilled
// by a rescan.
const found = new Map<string, string[]>()

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

/** A folder inside a repo: the repo, and the folders from its root down to it. */
export interface RepoPlace extends RepoFolder {
  folders: string[]
}

/**
 * The repo that contains `dir` (the envvault command's working directory),
 * and where in it `dir` is. The path is used only to work out the names; no
 * file is read.
 */
export async function repoAt(projectsPath: string, dir: string): Promise<RepoPlace> {
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
  const [name, ...folders] = relative(root, real).split(sep)
  const repoDir = name ? await findRepo(root, name) : null
  if (!name || !repoDir) throw notFound()
  return { name, dir: repoDir, folders }
}

/**
 * The paths of the env files in one folder of a repo (`folders` from its
 * root): the names isEnvFileName allows, whatever they are on disk. Empty if
 * the folder isn't there, is a symlink, or isn't one EnvVault syncs from.
 */
export async function envFilesIn(repoDir: string, folders: string[]): Promise<string[]> {
  const pathOf = (name: string): string => [...folders, name].join('/')
  if (!isEnvPath(pathOf(ROOT_ENV))) return []
  const envDir = await resolveEnvDir(repoDir, pathOf(ROOT_ENV)).catch(() => null)
  if (!envDir) return []
  const names = await readdir(envDir).catch(() => [])
  return names
    .filter((name) => isEnvPath(pathOf(name)))
    .sort()
    .map(pathOf)
}

/**
 * The folder the env file at `path` is in (the repo folder itself for its
 * root .env), or null if that folder doesn't exist. Refuses a symlink on the
 * way, which readRepoFile, checking only the file itself, wouldn't notice.
 */
export async function resolveEnvDir(repoDir: string, path: string): Promise<string | null> {
  let dir = repoDir
  const passed: string[] = []
  for (const name of envFolders(path)) {
    passed.push(name)
    dir = resolveInside(dir, name)
    let info
    try {
      info = await lstat(dir)
    } catch (err) {
      if (isErrno(err, 'ENOENT', 'ENOTDIR')) return null
      throw err
    }
    if (info.isSymbolicLink()) {
      throw new AppError(
        'ENV_SYMLINK',
        `${passed.join('/')} is a symlink, which EnvVault refuses to follow.`
      )
    }
    if (!info.isDirectory()) return null
  }
  return dir
}

/**
 * Exact bytes of the file `name` in the repo folder, or null if there is
 * none. Refuses symlinks: lstat rejects them up front, O_NOFOLLOW
 * (macOS/Linux) and an identity check on the opened handle close the window
 * where the file could be swapped for a symlink between the check and the
 * read. Messages name the file as `label`.
 */
export async function readRepoFile(
  repoDir: string,
  name: string,
  label = name
): Promise<Buffer | null> {
  const file = resolveInside(repoDir, name)
  const symlink = (): AppError =>
    new AppError('ENV_SYMLINK', `${label} is a symlink, which EnvVault refuses to follow.`)
  const tooLarge = (): AppError => new AppError('ENV_TOO_LARGE', `${label} is larger than 1 MiB.`)
  let info
  try {
    info = await lstat(file)
  } catch (err) {
    if (isErrno(err, 'ENOENT')) return null
    throw err
  }
  if (info.isSymbolicLink()) throw symlink()
  if (!info.isFile()) throw new AppError('ENV_NOT_FILE', `${label} is not a regular file.`)
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
      throw new AppError('ENV_NOT_FILE', `${label} changed while it was being read. Try again.`)
    }
    if (opened.size > MAX_ENV_BYTES) throw tooLarge()
    return await fh.readFile()
  } finally {
    await fh.close()
  }
}

/**
 * Exact bytes of the env file at `path`, in its folder `envDir` (see
 * resolveEnvDir), or null if there is none (see readRepoFile).
 */
export function readEnvFile(envDir: string, path: string): Promise<Buffer | null> {
  return readRepoFile(envDir, envFileName(path), path)
}

function syncedHash(env: Buffer): string {
  const synced = syncedBytes(env)
  try {
    return sha256Hex(synced)
  } finally {
    if (synced !== env) synced.fill(0)
  }
}

/** The env file at `path` in the repo at `repoDir`, as it is now. */
export async function scanEnvFile(repoDir: string, path: string): Promise<ScannedFile> {
  try {
    const envDir = await resolveEnvDir(repoDir, path)
    const env = envDir ? await readEnvFile(envDir, path) : null
    try {
      return {
        path,
        folderExists: envDir !== null,
        localHash: env ? syncedHash(env) : null,
        envError: null
      }
    } finally {
      env?.fill(0)
    }
  } catch (err) {
    if (!(err instanceof AppError)) throw err
    return { path, folderExists: true, localHash: null, envError: err }
  }
}

/** The git repos in the projects folder, in folder order. Reads no files. */
export async function listFolders(projectsPath: string): Promise<RepoFolder[]> {
  const root = await projectsRoot(projectsPath)
  const entries = await readdir(root, { withFileTypes: true })
  const folders = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map(async (entry): Promise<RepoFolder | null> => {
        const dir = await findRepo(root, entry.name)
        return dir ? { name: entry.name, dir } : null
      })
  )
  return folders.filter((f): f is RepoFolder => f !== null)
}

/**
 * Each repo's env files as they are now: its root .env and the files git
 * found in it, those its rules (`rulesFor`) include. With `find`, git is
 * asked again; without it, the files it found last time are used, so
 * background work runs no git. A repo git can't answer for gets its root
 * .env only.
 */
export async function scanRepos(
  repos: RepoFolder[],
  opts: { find?: boolean; rulesFor: (repo: RepoFolder) => FileRules }
): Promise<ScannedRepo[]> {
  const limit = createLimit(FINDING_AT_ONCE)
  return Promise.all(
    repos.map(async (repo): Promise<ScannedRepo> => {
      if (opts.find) {
        const paths = await limit(() => findEnvFiles(repo.dir))
        if (paths) found.set(repo.dir, paths.slice(0, MAX_FOUND))
        else found.delete(repo.dir)
      }
      const rules = opts.rulesFor(repo)
      const others = (found.get(repo.dir) ?? []).filter(
        (path) => path !== ROOT_ENV && isIncluded(path, rules)
      )
      const paths = [...(isIncluded(ROOT_ENV, rules) ? [ROOT_ENV] : []), ...others]
      return {
        ...repo,
        files: await Promise.all(paths.slice(0, MAX_FILES).map((p) => scanEnvFile(repo.dir, p))),
        found: found.get(repo.dir) ?? null
      }
    })
  )
}
