// The envvault command: status and push for the repo you're in, done by the
// running EnvVault app (src/main/cliserver.ts). It never sees the key or a
// value, only key names, statuses and hashes.
import { parseArgs } from 'node:util'
import { cliEndpoint } from '../core/cliendpoint'
import { isEnvPath } from '../core/envpath'
import { PROFILE_RE, type RepoTarget } from '../shared/cli'
import type { AppErrorInfo, ErrorCode, Result } from '../shared/result'
import type { Expected, RepoRow } from '../shared/types'
import { appUserData, client, type Machine } from './client'
import {
  decodeExpect,
  encodeExpect,
  fileLabel,
  formatPreview,
  formatPushed,
  formatRows
} from './format'

export interface Io extends Machine {
  argv: string[]
  cwd: string
  /** Both stdin and stdout are a terminal, so the user can be asked. */
  isTTY: boolean
  out(text: string): void
  err(text: string): void
  ask(question: string): Promise<string>
}

export const USAGE = `Usage:
  envvault status [--all]          the sync status of this repo's .env files, or every repo's
  envvault push                    show what would change, ask, then push the nearest .env
  envvault push --dry-run          only show what would change, with a token for --expect
  envvault push --expect <token>   push, if nothing changed since that dry run
  envvault push --yes              push without asking

push uses the .env in the current folder or the nearest one above it in the repo
(in a monorepo, run it in the package's folder), or else the repo's root .env.

Options:
  --repo <name>      a repo in your projects folder, instead of the current folder
  --path <path>      with push --repo: a .env in a folder of that repo, like apps/web/.env
  --json             print the result as JSON
  --profile <name>   use a dev profile's EnvVault (npm run dev:profile)

Needs EnvVault running and unlocked, with command-line access on in its Settings.
Exit codes: 0 done, 1 refused or failed, 2 usage, 3 locked, 4 EnvVault not reachable.
`

class UsageError extends Error {}

interface Options {
  command: 'status' | 'push' | 'help'
  json: boolean
  all: boolean
  repo: string | null
  path: string | null
  profile: string | null
  dryRun: boolean
  expect: Expected | null
  yes: boolean
}

function parseOptions(argv: string[], isTTY: boolean): Options {
  let parsed
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        json: { type: 'boolean' },
        all: { type: 'boolean' },
        repo: { type: 'string' },
        path: { type: 'string' },
        profile: { type: 'string' },
        'dry-run': { type: 'boolean' },
        expect: { type: 'string' },
        yes: { type: 'boolean', short: 'y' },
        help: { type: 'boolean', short: 'h' }
      }
    })
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : 'Invalid arguments.')
  }
  const { values: v, positionals } = parsed
  const [name, ...rest] = positionals
  const command = v.help ? 'help' : (name ?? 'help')
  if (command !== 'status' && command !== 'push' && command !== 'help') {
    throw new UsageError(`Unknown command: ${command}`)
  }
  if (rest.length) throw new UsageError(`Unexpected argument: ${rest[0]}`)
  if (v.profile !== undefined && !PROFILE_RE.test(v.profile)) {
    throw new UsageError('A profile name is 1-20 letters, digits or dashes.')
  }
  if (v.all && command !== 'status') throw new UsageError('--all works only with status.')
  if (v.all && v.repo !== undefined) throw new UsageError('Use --all or --repo, not both.')
  if (v.path !== undefined) {
    if (command !== 'push' || v.repo === undefined) {
      throw new UsageError('--path works only with push --repo.')
    }
    if (!isEnvPath(v.path)) {
      throw new UsageError("That isn't a .env in the repo. Use its path, like apps/web/.env.")
    }
  }
  const modes = [v['dry-run'], v.expect !== undefined, v.yes].filter(Boolean).length
  if (modes && command !== 'push') {
    throw new UsageError('--dry-run, --expect and --yes work only with push.')
  }
  if (modes > 1) throw new UsageError('Use only one of --dry-run, --expect and --yes.')
  let expect: Expected | null = null
  if (v.expect !== undefined) {
    expect = decodeExpect(v.expect)
    if (!expect) throw new UsageError("That --expect token isn't valid. Run push --dry-run again.")
  }
  if (command === 'push' && !modes && (v.json || !isTTY)) {
    throw new UsageError('Outside a terminal, or with --json, pass --dry-run, --expect or --yes.')
  }
  return {
    command,
    json: Boolean(v.json),
    all: Boolean(v.all),
    repo: v.repo ?? null,
    path: v.path ?? null,
    profile: v.profile ?? null,
    dryRun: Boolean(v['dry-run']),
    expect,
    yes: Boolean(v.yes)
  }
}

function exitCode(code: ErrorCode): number {
  if (code === 'LOCKED') return 3
  if (code === 'CLI_UNAVAILABLE') return 4
  return 1
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`

export async function main(io: Io): Promise<number> {
  let opts: Options
  try {
    opts = parseOptions(io.argv, io.isTTY)
  } catch (err) {
    if (!(err instanceof UsageError)) throw err
    if (io.argv.includes('--json')) {
      io.out(json({ ok: false, error: { code: 'BAD_REQUEST', message: err.message } }))
    } else {
      io.err(`envvault: ${err.message}\n\n${USAGE}`)
    }
    return 2
  }
  if (opts.command === 'help') {
    io.out(USAGE)
    return 0
  }

  const send = client(cliEndpoint(appUserData(io, opts.profile), io.platform))
  const target: RepoTarget =
    opts.repo === null
      ? { dir: io.cwd }
      : { repo: opts.repo, ...(opts.path !== null ? { path: opts.path } : {}) }
  const fail = (error: AppErrorInfo): number => {
    if (opts.json) io.out(json({ ok: false, error }))
    else io.err(`envvault: ${error.message}\n`)
    return exitCode(error.code)
  }

  if (opts.command === 'status') {
    const res = await send('status', opts.all ? { all: true } : target)
    if (!res.ok) return fail(res.error)
    io.out(opts.json ? json(res) : formatRows(res.data))
    return 0
  }

  // push
  const pushed = (res: Result<RepoRow>, before: Expected): number => {
    if (!res.ok) return fail(res.error)
    const unchanged = res.data.vault?.contentHash === before.vaultHash
    io.out(opts.json ? json(res) : formatPushed(res.data, unchanged))
    return 0
  }
  if (opts.expect) {
    return pushed(await send('push', { ...target, expected: opts.expect }), opts.expect)
  }
  const preview = await send('previewPush', target)
  if (!preview.ok) return fail(preview.error)
  const { repo, path, preview: p } = preview.data
  const label = fileLabel(repo, path)
  // Nothing to push is answered like a dry run.
  if (opts.dryRun || p.sameContent) {
    const expect = encodeExpect(p.expected)
    if (opts.json) {
      io.out(json({ ok: true, data: { repo, path, preview: p, expect } }))
    } else {
      io.out(formatPreview(label, p))
      if (!p.sameContent && !p.needsOverwrite) {
        // Run from the same folder, this finds the same file.
        const command = [
          'envvault',
          ...(opts.profile ? ['--profile', opts.profile] : []),
          'push',
          ...(opts.repo !== null ? ['--repo', opts.repo] : []),
          ...(opts.path !== null ? ['--path', opts.path] : []),
          '--expect',
          expect
        ]
        io.out(`To push this: ${command.join(' ')}\n`)
      }
    }
    return 0
  }
  if (!opts.json) io.out(formatPreview(label, p))
  if (p.needsOverwrite) {
    // formatPreview has said why.
    if (opts.json) {
      return fail({
        code: 'OVERWRITE_NOT_CONFIRMED',
        message: 'The vault copy changed on another machine. Resolve it in EnvVault.'
      })
    }
    return 1
  }
  if (!opts.yes) {
    const answer = await io.ask('Push? [y/N] ')
    if (!/^y(es)?$/i.test(answer.trim())) {
      io.err('Nothing pushed.\n')
      return 1
    }
  }
  // Exactly the file that was previewed, wherever it was found.
  return pushed(await send('push', { repo, path, expected: p.expected }), p.expected)
}
