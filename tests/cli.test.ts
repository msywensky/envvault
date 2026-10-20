// The envvault command against the real socket server (a Unix socket, or a
// named pipe on Windows), with a fake command table in place of the vault.
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { appUserData, type Machine } from '../src/cli/client'
import { decodeExpect, encodeExpect, formatPreview, formatRows } from '../src/cli/format'
import { main } from '../src/cli/main'
import { cliEndpoint, type CliEndpoint } from '../src/core/cliendpoint'
import { CLI_PROTOCOL, type CliArgs, type CliCommand } from '../src/shared/cli'
import type { PushPreview, RepoRow } from '../src/shared/types'
import { configureCli, setCliAccess, type CliTable } from '../src/main/cliserver'
import { AppError } from '../src/main/errors'

const H1 = '1'.repeat(64)
const H2 = '2'.repeat(64)
const H3 = '3'.repeat(64)
const VAULT = {
  version: 4,
  contentHash: H2,
  updatedBy: 'laptop',
  updatedAt: '2026-10-17T12:00:00Z'
}
const ROW: RepoRow = {
  name: 'web',
  path: '.env',
  storedName: 'web.env.enc',
  status: 'local-newer',
  hasEnv: true,
  vault: VAULT,
  error: null
}

function preview(overrides: Partial<PushPreview> = {}): PushPreview {
  return {
    diff: { added: ['NEW_KEY'], removed: [], changed: ['DB_URL'], unchanged: 3 },
    needsOverwrite: false,
    vault: VAULT,
    sameContent: false,
    kept: ['DATA_DIR'],
    unmarked: [],
    example: null,
    expected: { localHash: H1, vaultHash: H2 },
    ...overrides
  }
}

let calls: { command: CliCommand; args: unknown }[] = []
let locked = false
let nextPreview = preview()
// The file the app finds from the working directory (see envTargetAt).
let nearest = '.env'

const any = <T>(): z.ZodType<T> => z.custom<T>(() => true)
const record = <C extends CliCommand>(command: C, args: CliArgs[C]): void => {
  if (locked) throw new AppError('LOCKED', 'The vault is locked.')
  calls.push({ command, args })
}
const table: CliTable = {
  status: {
    schema: any(),
    run: async (args) => {
      record('status', args)
      return [ROW]
    }
  },
  previewPush: {
    schema: any(),
    run: async (args) => {
      record('previewPush', args)
      if ('dir' in args) return { repo: 'web', path: nearest, preview: nextPreview }
      return { repo: args.repo, path: args.path ?? '.env', preview: nextPreview }
    }
  },
  push: {
    schema: any(),
    run: async (args) => {
      record('push', args)
      return { ...ROW, status: 'in-sync', vault: { ...VAULT, version: 5, contentHash: H3 } }
    }
  }
}

let root: string
let machine: Machine
let endpoint: CliEndpoint

interface Run {
  code: number
  out: string
  err: string
  asked: string[]
}

async function cli(argv: string[], opts: { tty?: boolean; answer?: string } = {}): Promise<Run> {
  const run: Run = { code: -1, out: '', err: '', asked: [] }
  run.code = await main({
    ...machine,
    argv,
    cwd: '/work/web/src',
    isTTY: opts.tty ?? false,
    out: (t) => (run.out += t),
    err: (t) => (run.err += t),
    ask: async (q) => {
      run.asked.push(q)
      return opts.answer ?? ''
    }
  })
  return run
}

/** Send raw bytes to the server and collect whatever comes back. */
function raw(payload: string): Promise<string> {
  return new Promise((resolve) => {
    let out = ''
    const socket = connect(endpoint.address)
    socket.on('connect', () => socket.write(payload))
    socket.on('data', (d) => (out += d.toString()))
    socket.on('error', () => undefined)
    socket.on('close', () => resolve(out))
  })
}

const token = (): string => readFileSync(endpoint.tokenFile, 'utf8')

beforeAll(async () => {
  // Unix socket paths are limited to ~104 bytes, and macOS's tmpdir is long.
  root = mkdtempSync(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'evc-'))
  // The command finds userData the way Electron does; 'linux' keeps it short.
  machine = {
    platform: process.platform === 'win32' ? 'win32' : 'linux',
    home: root,
    env: { XDG_CONFIG_HOME: root, APPDATA: root }
  }
  const userData = appUserData(machine, null)
  endpoint = cliEndpoint(userData, process.platform)
  configureCli(userData, table)
  expect(await setCliAccess(true)).toBe(true)
})

afterAll(async () => {
  await setCliAccess(false)
  rmSync(root, { recursive: true, force: true })
})

beforeEach(() => {
  calls = []
  locked = false
  nextPreview = preview()
  nearest = '.env'
})

describe('envvault status', () => {
  it('asks about the current folder and prints the row', async () => {
    const r = await cli(['status'])
    expect(r.code).toBe(0)
    expect(calls).toEqual([{ command: 'status', args: { dir: '/work/web/src' } }])
    expect(r.out).toMatch(/^web {2}local newer: push to update the vault \(vault v4, by laptop, /)
  })

  it('takes --repo or --all, and prints JSON', async () => {
    await cli(['status', '--repo', 'web'])
    await cli(['status', '--all'])
    expect(calls.map((c) => c.args)).toEqual([{ repo: 'web' }, { all: true }])
    const r = await cli(['status', '--json'])
    expect(JSON.parse(r.out)).toEqual({ ok: true, data: [ROW] })
  })
})

describe('envvault push', () => {
  it('dry-runs with a token, and --expect pushes exactly what was previewed', async () => {
    const dry = await cli(['push', '--dry-run', '--json'])
    expect(dry.code).toBe(0)
    const data = JSON.parse(dry.out).data
    expect(data).toMatchObject({ repo: 'web', expect: `${H1}.${H2}` })
    expect(calls.map((c) => c.command)).toEqual(['previewPush'])
    const text = await cli(['push', '--dry-run', '--repo', 'web'])
    expect(text.out).toContain(`To push this: envvault push --repo web --expect ${H1}.${H2}\n`)
    calls = []

    const r = await cli(['push', '--expect', data.expect])
    expect(r.code).toBe(0)
    expect(r.out).toBe("Pushed web's .env to the vault (v5).\n")
    expect(calls).toEqual([
      {
        command: 'push',
        args: { dir: '/work/web/src', expected: { localHash: H1, vaultHash: H2 } }
      }
    ])
  })

  it('shows the changes and asks first in a terminal', async () => {
    const no = await cli(['push'], { tty: true, answer: 'n' })
    expect(no.code).toBe(1)
    expect(no.asked).toEqual(['Push? [y/N] '])
    expect(no.out).toContain('added:     NEW_KEY')
    expect(no.out).toContain('machine-specific, value kept here: DATA_DIR')
    expect(calls.map((c) => c.command)).toEqual(['previewPush'])

    const yes = await cli(['push'], { tty: true, answer: 'y' })
    expect(yes.code).toBe(0)
    expect(calls.at(-1)).toEqual({
      command: 'push',
      args: { repo: 'web', path: '.env', expected: { localHash: H1, vaultHash: H2 } }
    })
  })

  it('pushes exactly the file it previewed, in a folder of a monorepo', async () => {
    nearest = 'apps/web/.env'
    const r = await cli(['push', '--yes'])
    expect(r.code).toBe(0)
    expect(r.out).toContain('web/apps/web/.env: push to the vault as v5')
    expect(calls.at(-1)).toEqual({
      command: 'push',
      args: { repo: 'web', path: 'apps/web/.env', expected: { localHash: H1, vaultHash: H2 } }
    })
  })

  it('names a .env in a folder of a repo with --path', async () => {
    const dry = await cli(['push', '--dry-run', '--repo', 'platform', '--path', 'apps/web/.env'])
    expect(dry.code).toBe(0)
    expect(calls.map((c) => c.args)).toEqual([{ repo: 'platform', path: 'apps/web/.env' }])
    expect(dry.out).toContain('platform/apps/web/.env: push to the vault as v5')
    expect(dry.out).toContain(
      `To push this: envvault push --repo platform --path apps/web/.env --expect ${H1}.${H2}\n`
    )
    const j = await cli([
      'push',
      '--dry-run',
      '--json',
      '--repo',
      'platform',
      '--path',
      'apps/web/.env'
    ])
    expect(JSON.parse(j.out).data).toMatchObject({ repo: 'platform', path: 'apps/web/.env' })
  })

  it('never pushes over a vault copy that changed elsewhere', async () => {
    nextPreview = preview({ needsOverwrite: true })
    const r = await cli(['push', '--yes'])
    expect(r.code).toBe(1)
    expect(r.out).toContain('Resolve it in EnvVault')
    const j = await cli(['push', '--yes', '--json'])
    expect(JSON.parse(j.out)).toMatchObject({
      ok: false,
      error: { code: 'OVERWRITE_NOT_CONFIRMED' }
    })
    expect(calls.map((c) => c.command)).toEqual(['previewPush', 'previewPush'])
  })

  it('has nothing to do when the vault already has this content', async () => {
    nextPreview = preview({ sameContent: true })
    const r = await cli(['push', '--yes'])
    expect(r.code).toBe(0)
    expect(r.out).toBe('web: already in sync (vault v4)\n')
    expect(calls.map((c) => c.command)).toEqual(['previewPush'])
  })
})

describe('exit codes', () => {
  it('2 for usage errors, before contacting the app', async () => {
    for (const argv of [
      ['push'],
      ['push', '--json'],
      ['status', '--dry-run'],
      ['status', '--all', '--repo', 'web'],
      ['push', '--yes', '--dry-run'],
      ['push', '--expect', 'nonsense'],
      ['pull'],
      ['status', 'extra'],
      ['status', '--profile', 'no spaces'],
      ['status', '--bogus'],
      ['push', '--yes', '--path', 'apps/web/.env'],
      ['status', '--repo', 'web', '--path', '.env'],
      ['push', '--yes', '--repo', 'web', '--path', '../.env'],
      ['push', '--yes', '--repo', 'web', '--path', 'apps/web/.env.example'],
      ['push', '--yes', '--repo', 'web', '--path', 'apps\\web\\.env']
    ]) {
      expect((await cli(argv)).code, argv.join(' ')).toBe(2)
    }
    expect(calls).toEqual([])
    const j = await cli(['push', '--json'])
    expect(JSON.parse(j.out)).toMatchObject({ ok: false, error: { code: 'BAD_REQUEST' } })
  })

  it('3 when locked, 4 when EnvVault is not reachable', async () => {
    locked = true
    const r = await cli(['status'])
    expect(r.code).toBe(3)
    expect(r.err).toBe('envvault: The vault is locked.\n')
    locked = false

    expect((await cli(['status', '--profile', 'elsewhere'])).code).toBe(4)
    expect(await setCliAccess(false)).toBe(true)
    try {
      expect(existsSync(endpoint.tokenFile)).toBe(false)
      if (process.platform !== 'win32') expect(existsSync(endpoint.address)).toBe(false)
      const off = await cli(['status', '--json'])
      expect(off.code).toBe(4)
      expect(JSON.parse(off.out)).toMatchObject({ error: { code: 'CLI_UNAVAILABLE' } })
    } finally {
      expect(await setCliAccess(true)).toBe(true)
    }
    expect((await cli(['status'])).code).toBe(0)
  })
})

describe('the server', () => {
  const request = (fields: Record<string, unknown>): string =>
    `${JSON.stringify({ v: CLI_PROTOCOL, token: token(), command: 'status', args: { all: true }, ...fields })}\n`

  it('answers only requests with the current token', async () => {
    expect(JSON.parse(await raw(request({})))).toMatchObject({ ok: true })
    expect(JSON.parse(await raw(request({ token: 'f'.repeat(64) })))).toEqual({
      ok: false,
      error: { code: 'FORBIDDEN', message: 'Request rejected.' }
    })
    expect(calls).toHaveLength(1)
  })

  it('rejects malformed requests without echoing them', async () => {
    for (const bad of [
      'not json\n',
      `${JSON.stringify({ v: CLI_PROTOCOL, token: token(), command: 'status' })}\n`,
      request({ command: 'pull' }),
      request({ command: 'toString' }),
      // The protocol before env files in folders, and one from the future.
      request({ v: 1 }),
      request({ v: CLI_PROTOCOL + 1 })
    ]) {
      const reply = JSON.parse(await raw(bad))
      expect(reply).toMatchObject({ ok: false, error: { code: 'BAD_REQUEST' } })
      expect(reply.error.message).not.toMatch(/pull|toString|json/)
    }
    expect(calls).toEqual([])
  })

  it('drops a request line over 64 KiB', async () => {
    expect(await raw('x'.repeat(70 * 1024))).toBe('')
    expect(await raw(request({ pad: 'x'.repeat(70 * 1024) }))).toBe('')
  })

  it.skipIf(process.platform === 'win32')('keeps the socket and token file private', () => {
    expect(statSync(endpoint.address).mode & 0o777).toBe(0o600)
    expect(statSync(endpoint.tokenFile).mode & 0o777).toBe(0o600)
  })
})

describe('format', () => {
  it("names each row's file, a repo's root .env by the repo alone", () => {
    const text = formatRows([
      ROW,
      { ...ROW, path: 'apps/web/.env', storedName: 'web.0123456789abcdef.file.enc' },
      {
        ...ROW,
        path: null,
        storedName: 'web.fedcba9876543210.file.enc',
        status: 'error',
        vault: null,
        error: { code: 'VAULT_TAMPERED', message: 'It failed verification.' }
      }
    ])
    expect(text.split('\n')).toEqual([
      expect.stringMatching(/^web {32}local newer: /),
      expect.stringMatching(/^web\/apps\/web\/\.env {18}local newer: /),
      'web/web.fedcba9876543210.file.enc  error: It failed verification.',
      ''
    ])
  })

  it('round-trips the --expect token', () => {
    const e = { localHash: H1, vaultHash: null }
    expect(decodeExpect(encodeExpect(e))).toEqual(e)
    expect(decodeExpect(`${H1}.${H2}`)).toEqual({ localHash: H1, vaultHash: H2 })
    for (const bad of ['', H1, `${H1}.`, `${H1}.${H2}.`, `${'a'.repeat(64).toUpperCase()}.none`]) {
      expect(decodeExpect(bad)).toBeNull()
    }
  })

  it('warns about values that would be uploaded and .env.example findings', () => {
    const text = formatPreview(
      'web',
      preview({
        vault: null,
        unmarked: ['DATA_DIR'],
        example: {
          status: 'ok',
          tracked: true,
          missing: ['A'],
          undocumented: ['B'],
          sameValue: ['C']
        }
      })
    )
    expect(text).toContain('web: push to the vault as v1 (not in the vault yet)')
    expect(text).toContain(
      "warning: the vault marks DATA_DIR machine-specific but your .env doesn't, so its value would be uploaded"
    )
    expect(text).toContain('.env.example lists keys your .env lacks: A')
    expect(text).toContain("doesn't document: B")
    expect(text).toContain('same secret-looking value in .env.example: C')
  })
})
