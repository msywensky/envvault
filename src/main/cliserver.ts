// Lets the envvault command (src/cli) talk to the running app while the
// cliAccess setting is on. It listens on a Unix socket (macOS) or a named
// pipe (Windows) at cliEndpoint(userData), and every request must carry the
// random token in a user-only file next to it: the socket is mode 0600, but
// a Windows pipe lets anyone open it for reading. One JSON request line per
// connection, one JSON Result line back. Requests never go through
// ipcHooks, so they don't reset the idle auto-lock.
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { rmSync } from 'node:fs'
import { chmod, mkdir, rm } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { basename, dirname } from 'node:path'
import { z } from 'zod'
import { cliEndpoint, type CliEndpoint } from '../core/cliendpoint'
import { CLI_PROTOCOL, type CliArgs, type CliCommand, type CliResponses } from '../shared/cli'
import type { Result } from '../shared/result'
import { errnoCode, fail, failureOf } from './errors'
import { atomicWrite } from './fsutil'
import { createSerial } from './mutex'

export type CliTable = {
  [C in CliCommand]: {
    schema: z.ZodType<CliArgs[C]>
    run: (args: CliArgs[C]) => Promise<CliResponses[C]>
  }
}

const MAX_REQUEST_BYTES = 64 * 1024
/** For the request line to arrive; running the command isn't limited. */
const REQUEST_TIMEOUT_MS = 10_000
const MAX_CONNECTIONS = 4

const Envelope = z.strictObject({
  v: z.number(),
  token: z.string().max(200),
  command: z.string().max(64),
  args: z.unknown()
})

let configured: { endpoint: CliEndpoint; table: CliTable } | null = null
let server: Server | null = null
const sockets = new Set<Socket>()
// Start and stop must not interleave (Settings can be saved twice quickly).
const serial = createSerial()

/** Call once at startup, before setCliAccess. */
export function configureCli(userData: string, table: CliTable): void {
  configured = { endpoint: cliEndpoint(userData, process.platform), table }
}

/** Start or stop listening. False if it should be listening but couldn't start. */
export function setCliAccess(on: boolean): Promise<boolean> {
  return serial(async () => {
    if (!configured) return !on
    if (!on) {
      await stop(configured.endpoint)
      return true
    }
    if (server) return true
    try {
      await start(configured.endpoint, configured.table)
      return true
    } catch (err) {
      console.error(
        `[envvault] command-line access failed to start: ${errnoCode(err) ?? (err instanceof Error ? err.name : 'unknown')}`
      )
      await stop(configured.endpoint).catch(() => undefined)
      return false
    }
  })
}

/** Synchronous cleanup for will-quit, which can't wait for promises. */
export function stopCliNow(): void {
  if (!configured) return
  server?.close()
  server = null
  for (const socket of sockets) socket.destroy()
  rmSync(configured.endpoint.tokenFile, { force: true })
  if (process.platform !== 'win32') rmSync(configured.endpoint.address, { force: true })
}

async function start(endpoint: CliEndpoint, table: CliTable): Promise<void> {
  const token = Buffer.from(randomBytes(32).toString('hex'))
  await mkdir(dirname(endpoint.tokenFile), { recursive: true })
  // A socket left by a crash. The single-instance lock means it isn't live.
  if (process.platform !== 'win32') await rm(endpoint.address, { force: true })
  const srv = createServer((socket) => serve(socket, table, token))
  srv.maxConnections = MAX_CONNECTIONS
  await new Promise<void>((resolve, reject) => {
    srv.once('error', reject)
    srv.listen(endpoint.address, () => {
      srv.off('error', reject)
      resolve()
    })
  })
  server = srv
  srv.on('error', (err) => console.error(`[envvault] command-line server: ${err.name}`))
  if (process.platform !== 'win32') await chmod(endpoint.address, 0o600)
  // Written last, so the command finds a token only once the server is up.
  await atomicWrite(dirname(endpoint.tokenFile), basename(endpoint.tokenFile), token)
}

async function stop(endpoint: CliEndpoint): Promise<void> {
  const srv = server
  server = null
  await rm(endpoint.tokenFile, { force: true })
  for (const socket of sockets) socket.destroy()
  if (srv) await new Promise<void>((resolve) => srv.close(() => resolve()))
  if (process.platform !== 'win32') await rm(endpoint.address, { force: true })
}

function serve(socket: Socket, table: CliTable, token: Buffer): void {
  sockets.add(socket)
  socket.on('close', () => sockets.delete(socket))
  socket.on('error', () => undefined)
  socket.setTimeout(REQUEST_TIMEOUT_MS, () => socket.destroy())
  const chunks: Buffer[] = []
  let size = 0
  const onData = (chunk: Buffer): void => {
    const end = chunk.indexOf(0x0a)
    if ((end === -1 ? size + chunk.length : size + end) > MAX_REQUEST_BYTES) {
      socket.destroy()
      return
    }
    if (end === -1) {
      chunks.push(chunk)
      size += chunk.length
      return
    }
    chunks.push(chunk.subarray(0, end))
    socket.off('data', onData)
    socket.setTimeout(0)
    void dispatch(Buffer.concat(chunks).toString('utf8'), table, token).then((result) => {
      if (!socket.destroyed) socket.end(`${JSON.stringify(result)}\n`)
    })
  }
  socket.on('data', onData)
}

function tokenMatches(given: string, token: Buffer): boolean {
  const bytes = Buffer.from(given)
  return bytes.length === token.length && timingSafeEqual(bytes, token)
}

// Error messages never echo the request (see ipc.ts).
async function dispatch(line: string, table: CliTable, token: Buffer): Promise<Result<unknown>> {
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return fail('BAD_REQUEST', 'Invalid request.')
  }
  const req = Envelope.safeParse(raw)
  if (!req.success) return fail('BAD_REQUEST', 'Invalid request.')
  if (!tokenMatches(req.data.token, token)) return fail('FORBIDDEN', 'Request rejected.')
  if (req.data.v !== CLI_PROTOCOL) {
    return fail('BAD_REQUEST', 'This envvault command is for a different version of EnvVault.')
  }
  if (!Object.hasOwn(table, req.data.command)) return fail('BAD_REQUEST', 'Unknown command.')
  const command = req.data.command as CliCommand
  // TS can't relate a command picked at runtime to its schema and handler.
  const entry = table[command] as unknown as {
    schema: z.ZodType
    run: (args: unknown) => Promise<unknown>
  }
  const args = entry.schema.safeParse(req.data.args)
  if (!args.success) return fail('BAD_REQUEST', 'Invalid request.')
  try {
    return { ok: true, data: await entry.run(args.data) }
  } catch (err) {
    return { ok: false, error: failureOf(err, `cli ${command}`) }
  }
}
