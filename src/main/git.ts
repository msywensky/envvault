import { lstat, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROOT_ENV, backupName, envFileName, envPathId, isEnvPath } from '../core/envpath'
import { parseGitVersion } from '../core/gitremote'
import type { GitignoreResult } from '../shared/types'
import { AppError } from './errors'
import { findExecutable, firstLine, runProcess, type RunOptions, type RunResult } from './exec'
import { isErrno } from './fsutil'

// Added by "Add to .gitignore" after the env file's name. .env.bak.* covers
// the backups of every env file, and the pull temp file.
const BACKUP_IGNORE_LINE = '.env.bak.*'

const GIT_MISSING = 'Git was not found. Install Git and make sure it is on PATH.'

let gitPath: string | null = null

/** Absolute path of git (see findExecutable for why it must be absolute). */
async function findGit(): Promise<string> {
  gitPath ??= await findExecutable('git')
  if (!gitPath) throw new AppError('GIT_MISSING', GIT_MISSING)
  return gitPath
}

/** Run git with exactly these arguments and environment. Fails only if git can't start. */
export async function runGit(args: string[], opts: RunOptions): Promise<RunResult> {
  const exe = await findGit()
  try {
    return await runProcess(exe, args, opts)
  } catch (err) {
    if (isErrno(err, 'ENOENT')) {
      gitPath = null
      throw new AppError('GIT_MISSING', GIT_MISSING)
    }
    throw err
  }
}

let version: Promise<[number, number] | null> | null = null

/** GIT_TOO_OLD unless git is 2.32 or newer (GIT_CONFIG_GLOBAL), which git vaults need. */
export async function requireGitVersion(): Promise<void> {
  version ??= runGit(['--version'], { cwd: tmpdir(), env: process.env, timeoutMs: 15_000 }).then(
    (r) => (r.code === 0 ? parseGitVersion(r.stdout.toString('utf8')) : null),
    (err: unknown) => {
      version = null
      throw err
    }
  )
  const v = await version
  if (!v || v[0] < 2 || (v[0] === 2 && v[1] < 32)) {
    throw new AppError(
      'GIT_TOO_OLD',
      'A git vault needs git 2.32 or newer. Update git, then try again.'
    )
  }
}

/**
 * Run git in `cwd`, a repo or a folder inside one. `core.fsmonitor=false`
 * stops a repo's own .git/config from making git run an arbitrary command
 * (fsmonitor hooks run on index reads).
 */
function inRepo(cwd: string, args: string[]): Promise<RunResult> {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }
  return runGit(['-c', 'core.fsmonitor=false', ...args], { cwd, env, timeoutMs: 15_000 })
}

/** Run git in `cwd` (see inRepo) and return its exit code (0 or 1). Anything else is an error. */
async function git(cwd: string, args: string[]): Promise<0 | 1> {
  const { code, stderr, failure } = await inRepo(cwd, args)
  if (code === 0 || code === 1) return code
  const first = failure === 'timeout' ? 'timed out' : firstLine(stderr)
  throw new AppError('GIT_ERROR', `git ${args[0]} failed${first ? `: ${first}` : '.'}`)
}

// The checks below run git in `dir`, the folder an env file is in, with paths
// relative to it: git finds the repo by walking up, as it would in a shell.

/** True if `relPath` (relative to `dir`) is ignored by git. */
export async function checkIgnored(dir: string, relPath: string): Promise<boolean> {
  return (await git(dir, ['check-ignore', '-q', '--', relPath])) === 0
}

/**
 * True if `relPath` (relative to `dir`) is tracked. check-ignore never
 * reports tracked files as ignored, so a committed .env must be detected
 * separately.
 */
export async function isTracked(dir: string, relPath: string): Promise<boolean> {
  return (await git(dir, ['ls-files', '--error-unmatch', '--', relPath])) === 0
}

// Representative names for the files a pull of `name` creates next to it:
// its backup and the plaintext temp file (.env.bak.tmp-<hex>).
const backupSamples = (name: string): string[] => [
  backupName(name, '20000101T000000Z'),
  '.env.bak.tmp-0000000000000000'
]

/** True if git would ignore the backup and temp files a pull of `name` creates in `dir`. */
export async function backupsIgnored(dir: string, name: string): Promise<boolean> {
  const results = await Promise.all(backupSamples(name).map((s) => checkIgnored(dir, s)))
  return results.every(Boolean)
}

/** The three checks a pull of the env file `name` in `dir` depends on. */
export async function ignoreStatus(dir: string, name: string): Promise<GitignoreResult> {
  const [ignored, backupIgnored, tracked] = await Promise.all([
    checkIgnored(dir, name),
    backupsIgnored(dir, name),
    isTracked(dir, name)
  ])
  return { ignored, backupIgnored, tracked }
}

// Every file named like an env file (see isEnvFileName), in any folder. Which
// of them a repo syncs is up to its rules, applied when listing.
const ENV_PATHSPECS = [':(glob)**/.env', ':(glob)**/.env.*']

const lsFiles = (repoDir: string, args: string[]): Promise<RunResult> =>
  inRepo(repoDir, ['ls-files', '-z', ...args, '--', ...ENV_PATHSPECS])

/**
 * The env files git knows of in the repo at `repoDir`, as sorted paths from
 * its root: ignored ones (what a pull writes), untracked ones git would
 * commit (so that their pulls are refused with a reason), and tracked ones
 * named .env (a committed secret, refused the same way). Other tracked env
 * files, like a committed .env.development, are defaults git already syncs,
 * and are left out. Ignored folders (node_modules, build output) are listed
 * as folders and never read, so nothing inside one is found. ls-files reads
 * the index but, unlike `git status`, never refreshes it, so it runs no clean
 * filters. Null if git can't answer: not installed, a repo it refuses, a
 * timeout.
 */
export async function findEnvFiles(repoDir: string): Promise<string[] | null> {
  let results: RunResult[]
  try {
    results = await Promise.all([
      lsFiles(repoDir, ['--others', '--ignored', '--exclude-standard', '--directory']),
      lsFiles(repoDir, ['--others', '--exclude-standard']),
      lsFiles(repoDir, ['--cached'])
    ])
  } catch (err) {
    if (err instanceof AppError) return null
    throw err
  }
  if (results.some((r) => r.code !== 0)) return null
  const paths = (r: RunResult): string[] => r.stdout.toString('utf8').split('\0')
  const [ignored, untracked, tracked] = results.map(paths) as [string[], string[], string[]]
  const byId = new Map<string, string>()
  for (const path of [
    ...ignored,
    ...untracked,
    ...tracked.filter((p) => envFileName(p) === ROOT_ENV)
  ]) {
    // Drops the folders --directory lists, and anything EnvVault wouldn't sync.
    if (isEnvPath(path) && !byId.has(envPathId(path))) byId.set(envPathId(path), path)
  }
  return [...byId.values()].sort()
}

/**
 * Append the ignore lines that are missing (the env file's name `name`, and
 * its backups) to the repo root's .gitignore, then re-check the file in
 * `envDir` (the root or a folder in it). The lines have no "/", so they match
 * in every folder.
 */
export async function addToGitignore(
  repoDir: string,
  envDir: string,
  name: string
): Promise<GitignoreResult> {
  const file = join(repoDir, '.gitignore')
  let existing = ''
  try {
    if ((await lstat(file)).isSymbolicLink()) {
      throw new AppError('GITIGNORE_SYMLINK', '.gitignore is a symlink; edit it by hand.')
    }
    existing = await readFile(file, 'utf8')
  } catch (err) {
    if (!isErrno(err, 'ENOENT')) throw err
  }
  const present = new Set(existing.split(/\r?\n/).map((l) => l.trim()))
  const missing = [name, BACKUP_IGNORE_LINE].filter((l) => !present.has(l))
  if (missing.length > 0) {
    const eol = existing.includes('\r\n') ? '\r\n' : '\n'
    const sep = existing === '' || existing.endsWith('\n') ? '' : eol
    await writeFile(file, existing + sep + missing.join(eol) + eol)
  }
  return ignoreStatus(envDir, name)
}
