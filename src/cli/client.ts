// Finds the running app's endpoint and sends it one request (the protocol
// is in src/shared/cli.ts, the server in src/main/cliserver.ts).
import { readFile } from 'node:fs/promises'
import { connect } from 'node:net'
import path from 'node:path'
import type { CliEndpoint } from '../core/cliendpoint'
import { CLI_PROTOCOL, type CliArgs, type CliCommand, type CliResponses } from '../shared/cli'
import type { AppErrorInfo, Result } from '../shared/result'

// A push can wait behind an automatic pull, so this is generous.
const RESPONSE_TIMEOUT_MS = 60_000
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024

export interface Machine {
  platform: NodeJS.Platform
  home: string
  env: NodeJS.ProcessEnv
}

/** Electron's userData folder for the app, or for a dev profile of it (see main/index.ts). */
export function appUserData({ platform, home, env }: Machine, profile: string | null): string {
  const name = profile ? `envvault-${profile}` : 'envvault'
  if (platform === 'win32') {
    return path.win32.join(env['APPDATA'] ?? path.win32.join(home, 'AppData', 'Roaming'), name)
  }
  if (platform === 'darwin') return path.posix.join(home, 'Library', 'Application Support', name)
  return path.posix.join(env['XDG_CONFIG_HOME'] ?? path.posix.join(home, '.config'), name)
}

export type Send = <C extends CliCommand>(
  command: C,
  args: CliArgs[C]
) => Promise<Result<CliResponses[C]>>

const failure = (error: AppErrorInfo): { ok: false; error: AppErrorInfo } => ({ ok: false, error })
const unavailable = (): { ok: false; error: AppErrorInfo } =>
  failure({
    code: 'CLI_UNAVAILABLE',
    message: "EnvVault isn't running, or command-line access is off in its Settings."
  })
const lost = (): { ok: false; error: AppErrorInfo } =>
  failure({ code: 'INTERNAL', message: 'Lost contact with EnvVault.' })

function isErrno(err: unknown, ...codes: string[]): boolean {
  return (
    typeof err === 'object' && err !== null && 'code' in err && codes.includes(String(err.code))
  )
}

function parseReply<T>(text: string): Result<T> {
  try {
    const reply = JSON.parse(text) as unknown
    if (typeof reply === 'object' && reply !== null && 'ok' in reply) return reply as Result<T>
  } catch {
    // Fall through.
  }
  return lost()
}

export function client(endpoint: CliEndpoint): Send {
  return async function send<C extends CliCommand>(
    command: C,
    args: CliArgs[C]
  ): Promise<Result<CliResponses[C]>> {
    let token: string
    try {
      token = (await readFile(endpoint.tokenFile, 'utf8')).trim()
    } catch {
      // The app writes it once it's listening and deletes it when it stops.
      return unavailable()
    }
    return new Promise((resolve) => {
      const socket = connect(endpoint.address)
      const chunks: Buffer[] = []
      let size = 0
      socket.setTimeout(RESPONSE_TIMEOUT_MS, () => {
        socket.destroy()
        resolve(lost())
      })
      // write, not end: the server closes its side when a client half-closes.
      socket.on('connect', () => {
        socket.write(`${JSON.stringify({ v: CLI_PROTOCOL, token, command, args })}\n`)
      })
      socket.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > MAX_RESPONSE_BYTES) {
          socket.destroy()
          resolve(lost())
          return
        }
        chunks.push(chunk)
      })
      socket.on('end', () => resolve(parseReply(Buffer.concat(chunks).toString('utf8'))))
      socket.on('error', (err) =>
        resolve(isErrno(err, 'ENOENT', 'ECONNREFUSED') ? unavailable() : lost())
      )
      // Closed without a reply (the first resolve wins).
      socket.on('close', () => resolve(lost()))
    })
  }
}
