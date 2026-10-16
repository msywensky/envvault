import { execFile } from 'node:child_process'
import { lstat, readFile, stat, writeFile } from 'node:fs/promises'
import { delimiter, isAbsolute, join } from 'node:path'
import type { GitignoreResult } from '../shared/types'
import { AppError } from './errors'
import { isErrno } from './fsutil'

// Added by "Add to .gitignore". .env.bak.* also covers the pull temp file.
const IGNORE_LINES = ['.env', '.env.bak.*']

const GIT_MISSING = 'Git was not found. Install Git and make sure it is on PATH.'

function searchPath(): string[] {
  const dirs = (process.env['PATH'] ?? '').split(delimiter)
  // Apps launched from Finder get a minimal PATH without Homebrew.
  if (process.platform === 'darwin') dirs.push('/opt/homebrew/bin', '/usr/local/bin')
  return dirs
}

let gitPath: string | null = null

/**
 * Absolute path of git, found using absolute PATH entries only. Spawning
 * plain "git" with cwd = the repo lets a relative PATH entry (".", or an
 * unexpanded "%VAR%" on Windows) resolve inside the untrusted repo, so a
 * cloned repo could ship its own git.exe. (Verified on Electron 44.)
 */
async function findGit(): Promise<string> {
  if (gitPath) return gitPath
  const name = process.platform === 'win32' ? 'git.exe' : 'git'
  for (const dir of searchPath()) {
    if (!dir || !isAbsolute(dir)) continue
    const candidate = join(dir, name)
    try {
      if ((await stat(candidate)).isFile()) return (gitPath = candidate)
    } catch {
      // not here
    }
  }
  throw new AppError('GIT_MISSING', GIT_MISSING)
}

/**
 * Run git and return its exit code (0 or 1). Anything else is an error.
 * `core.fsmonitor=false` stops a repo's own .git/config from making git run
 * an arbitrary command (fsmonitor hooks run on index reads).
 */
async function git(cwd: string, args: string[]): Promise<0 | 1> {
  const exe = await findGit()
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }
  return new Promise((resolve, reject) => {
    execFile(
      exe,
      ['-c', 'core.fsmonitor=false', ...args],
      { cwd, env, windowsHide: true, timeout: 15_000 },
      (err, _stdout, stderr) => {
        if (!err) return resolve(0)
        if (isErrno(err, 'ENOENT')) {
          gitPath = null
          return reject(new AppError('GIT_MISSING', GIT_MISSING))
        }
        if (err.code === 1) return resolve(1)
        const first = String(stderr).split(/\r?\n/)[0]?.trim()
        reject(new AppError('GIT_ERROR', `git ${args[0]} failed${first ? `: ${first}` : '.'}`))
      }
    )
  })
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
  const [ignored, tracked] = await Promise.all([
    checkIgnored(repoDir, '.env'),
    isTracked(repoDir, '.env')
  ])
  return { ignored, tracked }
}
