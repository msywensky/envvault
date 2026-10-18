// Running git and gh: from an absolute path found through absolute PATH
// entries only, with a timeout and a cap on how much output is kept.
import { spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { delimiter, isAbsolute, join } from 'node:path'

function searchPath(): string[] {
  const dirs = (process.env['PATH'] ?? '').split(delimiter)
  // Apps launched from Finder get a minimal PATH without Homebrew.
  if (process.platform === 'darwin') dirs.push('/opt/homebrew/bin', '/usr/local/bin')
  return dirs
}

/**
 * Absolute path of an executable, or null. Spawning a plain name with cwd =
 * a repo lets a relative PATH entry (".", or an unexpanded "%VAR%" on
 * Windows) resolve inside the untrusted repo, so a cloned repo could ship
 * its own git.exe. (Verified on Electron 44.)
 */
export async function findExecutable(name: string): Promise<string | null> {
  const file = process.platform === 'win32' ? `${name}.exe` : name
  for (const dir of searchPath()) {
    if (!dir || !isAbsolute(dir)) continue
    const candidate = join(dir, file)
    try {
      if ((await stat(candidate)).isFile()) return candidate
    } catch {
      // not here
    }
  }
  return null
}

export interface RunOptions {
  cwd: string
  /** The whole environment (not added to process.env). */
  env: NodeJS.ProcessEnv
  input?: Uint8Array
  timeoutMs: number
  /** Most stdout kept before the process is killed. Default 1 MiB. */
  maxBytes?: number
}

export interface RunResult {
  /** The exit code, or null if it was killed (see `failure`). */
  code: number | null
  stdout: Buffer
  stderr: string
  failure?: 'timeout' | 'too-large'
}

const MAX_STDERR = 64 * 1024

/** Run `exe`. Rejects only if it can't be started (an errno error, e.g. ENOENT). */
export function runProcess(exe: string, args: string[], opts: RunOptions): Promise<RunResult> {
  const maxBytes = opts.maxBytes ?? 1024 * 1024
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, {
      cwd: opts.cwd,
      env: opts.env,
      windowsHide: true,
      stdio: [opts.input ? 'pipe' : 'ignore', 'pipe', 'pipe']
    })
    const out: Buffer[] = []
    let outBytes = 0
    let stderr = ''
    let failure: RunResult['failure']
    const kill = (why: NonNullable<RunResult['failure']>): void => {
      failure ??= why
      child.kill()
    }
    const timer = setTimeout(() => kill('timeout'), opts.timeoutMs)
    child.stdout?.on('data', (chunk: Buffer) => {
      outBytes += chunk.length
      if (outBytes > maxBytes) kill('too-large')
      else out.push(chunk)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_STDERR) stderr += chunk.toString('utf8')
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: failure ? null : code, stdout: Buffer.concat(out), stderr, failure })
    })
    if (opts.input && child.stdin) {
      // The process may exit without reading it all (EPIPE); its exit code says why.
      child.stdin.on('error', () => undefined)
      child.stdin.end(opts.input)
    }
  })
}

/** The first line of a process's stderr, trimmed, or ''. */
export const firstLine = (stderr: string): string => stderr.split(/\r?\n/)[0]?.trim() ?? ''
