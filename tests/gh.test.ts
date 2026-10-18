// The GitHub CLI wrapper (src/main/gh.ts) with canned gh output. The real gh
// is exercised by hand.
import { describe, expect, it } from 'vitest'
import type { RunResult } from '../src/main/exec'
import { createPrivateRepo, ghStatus, listPrivateRepos, type GhRunner } from '../src/main/gh'

type Canned = Record<string, { code?: number; stdout?: string; stderr?: string }>

/** A gh that answers `canned` by its arguments, and fails anything else. */
function fakeGh(canned: Canned): GhRunner & { calls: string[][] } {
  const calls: string[][] = []
  const run = async (args: string[]): Promise<RunResult> => {
    calls.push(args)
    const answer = canned[args.join(' ')]
    return {
      code: answer ? (answer.code ?? 0) : 1,
      stdout: Buffer.from(answer?.stdout ?? ''),
      stderr: answer ? (answer.stderr ?? '') : 'unexpected call'
    }
  }
  return Object.assign(run, { calls })
}

const AUTH = 'auth status --hostname github.com'
const USER = 'api user --jq .login'
const PROTOCOL = 'config get git_protocol --host github.com'
const LIST =
  'repo list --visibility private --no-archived --source --limit 100 --json nameWithOwner,sshUrl,url,isEmpty,updatedAt'
const CREATE =
  'repo create envvault-vault --private --disable-issues --disable-wiki --description EnvVault vault (encrypted .env files)'
const VIEW = 'repo view you/envvault-vault --json sshUrl,url'

const signedIn = (protocol: string): Canned => ({
  [AUTH]: {},
  [USER]: { stdout: 'you\n' },
  [PROTOCOL]: { stdout: `${protocol}\n` }
})

const repo = (name: string, isEmpty: boolean, updatedAt: string): object => ({
  nameWithOwner: `you/${name}`,
  sshUrl: `git@github.com:you/${name}.git`,
  url: `https://github.com/you/${name}`,
  isEmpty,
  updatedAt
})

describe('ghStatus', () => {
  it('reports gh missing, signed out, and signed in with its protocol', async () => {
    expect(await ghStatus(async () => null)).toEqual({
      available: false,
      signedIn: false,
      login: null,
      protocol: 'https'
    })
    expect(await ghStatus(fakeGh({ [AUTH]: { code: 1 } }))).toEqual({
      available: true,
      signedIn: false,
      login: null,
      protocol: 'https'
    })
    expect(await ghStatus(fakeGh(signedIn('ssh')))).toEqual({
      available: true,
      signedIn: true,
      login: 'you',
      protocol: 'ssh'
    })
    expect((await ghStatus(fakeGh(signedIn('https')))).protocol).toBe('https')
    // No protocol set: gh itself defaults to https.
    expect((await ghStatus(fakeGh({ [AUTH]: {}, [USER]: { stdout: 'you' } }))).protocol).toBe(
      'https'
    )
  })

  it('does not trust a login that is not one', async () => {
    const status = await ghStatus(fakeGh({ ...signedIn('ssh'), [USER]: { stdout: '-x; rm -rf' } }))
    expect(status).toMatchObject({ signedIn: false, login: null })
  })
})

describe('listPrivateRepos', () => {
  const listed = JSON.stringify([
    repo('old', false, '2026-01-01T00:00:00Z'),
    repo('new', false, '2026-10-01T00:00:00Z'),
    repo('empty', true, '2025-01-01T00:00:00Z')
  ])

  it('puts empty repositories first, then the latest, with the URL for the protocol', async () => {
    expect(
      await listPrivateRepos(fakeGh({ ...signedIn('ssh'), [LIST]: { stdout: listed } }))
    ).toEqual([
      {
        name: 'you/empty',
        url: 'git@github.com:you/empty.git',
        isEmpty: true,
        updatedAt: '2025-01-01T00:00:00Z'
      },
      {
        name: 'you/new',
        url: 'git@github.com:you/new.git',
        isEmpty: false,
        updatedAt: '2026-10-01T00:00:00Z'
      },
      {
        name: 'you/old',
        url: 'git@github.com:you/old.git',
        isEmpty: false,
        updatedAt: '2026-01-01T00:00:00Z'
      }
    ])
    const https = await listPrivateRepos(
      fakeGh({ ...signedIn('https'), [LIST]: { stdout: listed } })
    )
    expect(https.map((r) => r.url)).toEqual([
      'https://github.com/you/empty.git',
      'https://github.com/you/new.git',
      'https://github.com/you/old.git'
    ])
  })

  it('refuses output it does not understand, and drops URLs it would not accept', async () => {
    for (const stdout of ['not json', '{}', JSON.stringify([{ nameWithOwner: 'you/x' }])]) {
      await expect(
        listPrivateRepos(fakeGh({ ...signedIn('ssh'), [LIST]: { stdout } }))
      ).rejects.toMatchObject({ code: 'GH_UNAVAILABLE' })
    }
    const odd = JSON.stringify([{ ...repo('x', true, 'z'), sshUrl: 'ext::sh -c evil' }])
    expect(await listPrivateRepos(fakeGh({ ...signedIn('ssh'), [LIST]: { stdout: odd } }))).toEqual(
      []
    )
    await expect(listPrivateRepos(async () => null)).rejects.toMatchObject({
      code: 'GH_UNAVAILABLE'
    })
  })
})

describe('createPrivateRepo', () => {
  it('creates a private repository and returns its clone URL', async () => {
    const gh = fakeGh({
      ...signedIn('ssh'),
      [CREATE]: { stdout: 'https://github.com/you/envvault-vault\n' },
      [VIEW]: {
        stdout: JSON.stringify({
          sshUrl: 'git@github.com:you/envvault-vault.git',
          url: 'https://github.com/you/envvault-vault'
        })
      }
    })
    expect(await createPrivateRepo('envvault-vault', gh)).toBe(
      'git@github.com:you/envvault-vault.git'
    )
    const create = gh.calls.find((args) => args[1] === 'create')
    expect(create).toContain('--private')
    expect(create).not.toContain('--public')
  })

  it('validates the name before running gh', async () => {
    for (const name of ['', '-x', '.hidden', 'a b', 'a/b', 'x'.repeat(101), '--public']) {
      const gh = fakeGh(signedIn('ssh'))
      await expect(createPrivateRepo(name, gh), name).rejects.toMatchObject({ code: 'BAD_REQUEST' })
      expect(gh.calls).toEqual([])
    }
  })

  it('says when the name is taken', async () => {
    const gh = fakeGh({
      ...signedIn('ssh'),
      [CREATE]: {
        code: 1,
        stderr: 'GraphQL: Name already exists on this account (createRepository)\n'
      }
    })
    await expect(createPrivateRepo('envvault-vault', gh)).rejects.toMatchObject({
      code: 'GIT_VAULT_NAME_TAKEN'
    })
  })

  it('needs gh signed in', async () => {
    await expect(createPrivateRepo('envvault-vault', async () => null)).rejects.toMatchObject({
      code: 'GH_UNAVAILABLE'
    })
    await expect(
      createPrivateRepo('envvault-vault', fakeGh({ [AUTH]: { code: 1 } }))
    ).rejects.toMatchObject({ code: 'GH_UNAVAILABLE' })
  })
})
