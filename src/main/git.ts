import { lstat, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
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

/**
 * Run git in a repo and return its exit code (0 or 1). Anything else is an
 * error. `core.fsmonitor=false` stops a repo's own .git/config from making
 * git run an arbitrary command (fsmonitor hooks run on index reads).
 */
async function git(cwd: string, args: string[]): Promise<0 | 1> {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }
  const { code, stderr, failure } = await runGit(['-c', 'core.fsmonitor=false', ...args], {
    cwd,
    env,
    timeoutMs: 15_000
  })
  if (code === 0 || code === 1) return code
  const first = failure === 'timeout' ? 'timed out' : firstLine(stderr)
  throw new AppError('GIT_ERROR', `git ${args[0]} failed${first ? `: ${first}` : '.'}`)
}

/** True if `relPath` (relative to the repo root) is ignored by git. */
export async function checkIgnored(repoDir: string, relPath: string): Promise<boolean> {
  return (await git(repoDir, ['check-ignore', '-q', '--', relPath])) === 0
}

/**
 * True if `relPath` is tracked. check-ignore never reports tracked files as
 * ignored, so a committed .env must be detected separately.
 */
export async function isTracked(repoDir: string, relPath: string): Promise<boolean> {
  return (await git(repoDir, ['ls-files', '--error-unmatch', '--', relPath])) === 0
}

// Representative names for the files a pull creates next to .env: the
// backup (.env.bak.<timestamp>) and the plaintext temp file (.env.bak.tmp-<hex>).
const BACKUP_SAMPLES = ['.env.bak.20000101T000000Z', '.env.bak.tmp-0000000000000000']

/** True if git would ignore the backup and temp files a pull creates. */
export async function backupsIgnored(repoDir: string): Promise<boolean> {
  const results = await Promise.all(BACKUP_SAMPLES.map((name) => checkIgnored(repoDir, name)))
  return results.every(Boolean)
}

/** The three checks a pull depends on. */
export async function ignoreStatus(repoDir: string): Promise<GitignoreResult> {
  const [ignored, backupIgnored, tracked] = await Promise.all([
    checkIgnored(repoDir, '.env'),
    backupsIgnored(repoDir),
    isTracked(repoDir, '.env')
  ])
  return { ignored, backupIgnored, tracked }
}

/** Append the .env ignore lines that are missing, then re-check. */
export async function addToGitignore(repoDir: string): Promise<GitignoreResult> {
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
  return ignoreStatus(repoDir)
}
