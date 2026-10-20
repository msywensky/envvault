import { lstat, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { envPathId, isEnvPath } from '../core/envpath'
import { parseGitVersion } from '../core/gitremote'
import type { GitignoreResult } from '../shared/types'
import { AppError } from './errors'
import { findExecutable, firstLine, runProcess, type RunOptions, type RunResult } from './exec'
import { isErrno } from './fsutil'

// Added by "Add to .gitignore". .env.bak.* also covers the pull temp file.
const IGNORE_LINES = ['.env', '.env.bak.*']

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

// Representative names for the files a pull creates next to .env: the
// backup (.env.bak.<timestamp>) and the plaintext temp file (.env.bak.tmp-<hex>).
const BACKUP_SAMPLES = ['.env.bak.20000101T000000Z', '.env.bak.tmp-0000000000000000']

/** True if git would ignore the backup and temp files a pull creates in `dir`. */
export async function backupsIgnored(dir: string): Promise<boolean> {
  const results = await Promise.all(BACKUP_SAMPLES.map((name) => checkIgnored(dir, name)))
  return results.every(Boolean)
}

/** The three checks a pull of the .env in `dir` depends on. */
export async function ignoreStatus(dir: string): Promise<GitignoreResult> {
  const [ignored, backupIgnored, tracked] = await Promise.all([
    checkIgnored(dir, '.env'),
    backupsIgnored(dir),
    isTracked(dir, '.env')
  ])
  return { ignored, backupIgnored, tracked }
}

// Every file named like an env file, in any folder.
const ENV_PATHSPECS = [':(glob)**/.env']

/**
 * The env files git knows of in the repo at `repoDir`, as sorted paths from
 * its root: ignored ones (what a pull writes), and tracked ones and untracked
 * ones git would commit, so that their pulls are refused with a reason.
 * Ignored folders (node_modules, build output) are listed as folders and
 * never read, so nothing inside one is found. ls-files reads the index but,
 * unlike `git status`, never refreshes it, so it runs no clean filters.
 * Null if git can't answer: not installed, a repo it refuses, a timeout.
 */
export async function findEnvFiles(repoDir: string): Promise<string[] | null> {
  let results: RunResult[]
  try {
    results = await Promise.all([
      inRepo(repoDir, [
        'ls-files',
        '-z',
        '--others',
        '--ignored',
        '--exclude-standard',
        '--directory',
        '--',
        ...ENV_PATHSPECS
      ]),
      inRepo(repoDir, [
        'ls-files',
        '-z',
        '--cached',
        '--others',
        '--exclude-standard',
        '--',
        ...ENV_PATHSPECS
      ])
    ])
  } catch (err) {
    if (err instanceof AppError) return null
    throw err
  }
  if (results.some((r) => r.code !== 0)) return null
  const byId = new Map<string, string>()
  for (const path of results.flatMap((r) => r.stdout.toString('utf8').split('\0'))) {
    // Drops the folders --directory lists, and anything EnvVault wouldn't sync.
    if (isEnvPath(path) && !byId.has(envPathId(path))) byId.set(envPathId(path), path)
  }
  return [...byId.values()].sort()
}

/**
 * Append the .env ignore lines that are missing to the repo root's
 * .gitignore, then re-check the .env in `envDir` (the root or a folder in
 * it). The lines have no "/", so they match in every folder.
 */
export async function addToGitignore(repoDir: string, envDir: string): Promise<GitignoreResult> {
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
  const missing = IGNORE_LINES.filter((l) => !present.has(l))
  if (missing.length > 0) {
    const eol = existing.includes('\r\n') ? '\r\n' : '\n'
    const sep = existing === '' || existing.endsWith('\n') ? '' : eol
    await writeFile(file, existing + sep + missing.join(eol) + eol)
  }
  return ignoreStatus(envDir)
}
