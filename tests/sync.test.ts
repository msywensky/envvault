// Integration test for the main-process flows: real temp folders, real git,
// real crypto. Only Electron (for app.getPath) and the KDF worker (fast
// parameters instead of 256 MiB) are mocked. Two "machines" are simulated by
// reloading the main modules with a different userData folder.
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { decodeEnv, decryptPayload } from '../src/core/crypto'
import type { CliTable } from '../src/main/cliserver'
import { withRepo } from '../src/core/vaultsettings'
import type {
  EnvFile,
  PullPreview,
  RepoInfo,
  RepoList,
  RepoRow,
  RepoRules,
  VaultLocation
} from '../src/shared/types'

const h = vi.hoisted(() => ({ userData: '', setupCode: undefined as string | undefined }))

// safeStorage: a reversible stand-in for the Keychain / DPAPI.
vi.mock('electron', () => ({
  app: { getPath: () => h.userData },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (text: string) => Buffer.from(`sealed:${text}`),
    decryptString: (blob: Buffer) => {
      const text = blob.toString()
      if (!text.startsWith('sealed:')) throw new Error('not ours')
      return text.slice('sealed:'.length)
    }
  }
}))
// Git vaults in these tests are local bare repositories, which only
// allowLocal accepts (it also skips the https privacy check).
vi.mock('../src/main/store/git', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/main/store/git')>()
  class LocalGitStore extends mod.GitStore {
    constructor(opts: ConstructorParameters<typeof mod.GitStore>[0]) {
      super({ ...opts, allowLocal: true, cacheMs: 0 })
    }
  }
  return { ...mod, GitStore: LocalGitStore }
})
vi.mock('../src/main/kdf', async () => {
  const { deriveKey } = await import('../src/core/crypto')
  return {
    deriveKeyInWorker: (job: { password: string; salt: Uint8Array }) =>
      deriveKey(job.password, job.salt, { opslimit: 1, memlimit: 8 * 1024 * 1024 })
  }
})

const PASSWORD = 'correct horse battery staple'
let root: string
let vaultDir: string
let projA: string
let projB: string

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

function makeRepo(projects: string, name: string, files: Record<string, string>): string {
  const dir = join(projects, name)
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q')
  for (const [file, content] of Object.entries(files)) writeFileSync(join(dir, file), content)
  return dir
}

interface Machine {
  config: typeof import('../src/main/config')
  vault: typeof import('../src/main/vault')
  sync: typeof import('../src/main/sync')
  session: typeof import('../src/main/session')
  autopull: typeof import('../src/main/autopull')
  clicommands: typeof import('../src/main/clicommands')
  open: () => Promise<{ key: Uint8Array; vaultId: string }>
}

/** Load a fresh copy of the main modules for one "machine". */
async function machine(
  name: 'a' | 'b',
  where: { projects: string; vault: VaultLocation } | null = null
): Promise<Machine> {
  h.userData = join(root, `userData-${name}`)
  vi.resetModules()
  const config = await import('../src/main/config')
  const vault = await import('../src/main/vault')
  const sync = await import('../src/main/sync')
  const session = await import('../src/main/session')
  const autopull = await import('../src/main/autopull')
  const clicommands = await import('../src/main/clicommands')
  const location: VaultLocation = where?.vault ?? { kind: 'folder', path: vaultDir }
  await config.updateConfig({
    projectsPath: where?.projects ?? (name === 'a' ? projA : projB),
    vault: location
  })
  // A git vault is format 2: a machine's first unlock needs the setup code
  // from its creation (h.setupCode); after that the machine has it.
  const open = async (): Promise<{ key: Uint8Array; vaultId: string }> => {
    const v = vault.vaultFor(location)
    const needsCode = (await v.setupCodeState()) === 'needed'
    return v.open(PASSWORD, needsCode ? h.setupCode : undefined)
  }
  return { config, vault, sync, session, autopull, clicommands, open }
}

/** An env file: the repo's root .env unless `path` says otherwise. */
const envFile = (repoName: string, path = '.env'): EnvFile => ({ repoName, path })

/**
 * Each row's status (or error code), by repo name for a root .env and by
 * "repo/path" for any other file. `find` asks git which files each repo has.
 */
async function rows(m: Machine, find = false): Promise<Record<string, string>> {
  const { key, vaultId } = await m.open()
  const { rows: list } = await m.sync.listRepos(key, vaultId, { find })
  return Object.fromEntries(
    list.map((r) => [
      r.path === '.env' ? r.name : `${r.name}/${r.path ?? r.storedName}`,
      r.status === 'error' ? `error:${r.error?.code}` : r.status
    ])
  )
}

async function pushRepo(
  m: Machine,
  repo: string,
  overwriteConfirmed = false,
  path = '.env'
): Promise<void> {
  const { key, vaultId } = await m.open()
  const preview = await m.sync.previewPush(key, vaultId, envFile(repo, path))
  await m.sync.push(key, vaultId, {
    ...envFile(repo, path),
    overwriteConfirmed,
    expected: preview.expected
  })
}

async function pullRepo(m: Machine, repo: string, path = '.env'): Promise<string | null> {
  const { key, vaultId } = await m.open()
  const preview = await m.sync.previewPull(key, vaultId, envFile(repo, path))
  const req = { ...envFile(repo, path), expected: preview.expected }
  return (await m.sync.pull(key, vaultId, req)).backupName
}

const errorCode = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p
  } catch (err) {
    return (err as { code?: string }).code ?? String(err)
  }
  return 'no error'
}

/** An env file's vault copy as text ('' if there is none), read straight from a folder vault. */
async function storedEnv(
  m: Machine,
  repoName: string,
  path = '.env',
  folder = vaultDir
): Promise<string> {
  const { key } = await m.open()
  const entry = await m.vault.withEntryKeys(key, async (keys) =>
    (await m.vault.vaultAt(folder).snapshot()).read(
      keys,
      m.vault.entryFor(keys, { repoName, path })
    )
  )
  return Buffer.from(entry?.payload.envBase64 ?? '', 'base64').toString('utf8')
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'envvault-it-'))
  vaultDir = join(root, 'vault')
  projA = join(root, 'projects-a')
  projB = join(root, 'projects-b')
  mkdirSync(vaultDir)
  makeRepo(projA, 'app1', { '.gitignore': '.env\n.env.bak.*\n', '.env': 'A=1\n' })
  makeRepo(projA, 'app2', { '.gitignore': '.env\n.env.bak.*\n', '.env': 'B=2\n' })
  makeRepo(projA, 'app3', { '.env': 'C=3\n' })
  mkdirSync(join(projA, 'not-a-repo'))
  writeFileSync(join(projA, 'not-a-repo', '.env'), 'X=1\n')
  makeRepo(projB, 'app1', { '.gitignore': '.env\n.env.bak.*\n', '.env': 'A=1\nOLD=x\n' })
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('machine A: create vault and push', () => {
  it('creates a vault only with a long enough password, and only once', async () => {
    const m = await machine('a')
    expect(await m.vault.vaultAt(vaultDir).state()).toBe('empty')
    expect(await errorCode(m.vault.vaultAt(vaultDir).create('short'))).toBe('PASSWORD_TOO_SHORT')
    await m.vault.vaultAt(vaultDir).create(PASSWORD)
    expect(await m.vault.vaultAt(vaultDir).state()).toBe('ready')
    expect(await errorCode(m.vault.vaultAt(vaultDir).create(PASSWORD))).toBe('VAULT_EXISTS')
    const meta = JSON.parse(readFileSync(join(vaultDir, 'meta.json'), 'utf8'))
    expect(Object.keys(meta).sort()).toEqual(['formatVersion', 'kdf', 'keyCheck', 'vaultId'])
  })

  it('lists git repos only, all local-only at first', async () => {
    expect(await rows(await machine('a'))).toEqual({
      app1: 'local-only',
      app2: 'local-only',
      app3: 'local-only'
    })
  })

  it('previews and pushes, refusing a stale preview', async () => {
    const m = await machine('a')
    const { key, vaultId } = await m.open()
    const preview = await m.sync.previewPush(key, vaultId, envFile('app1'))
    expect(preview.diff).toEqual({ added: ['A'], removed: [], changed: [], unchanged: 0 })
    expect(preview.needsOverwrite).toBe(false)
    writeFileSync(join(projA, 'app1', '.env'), 'A=1\nLATE=1\n')
    expect(
      await errorCode(
        m.sync.push(key, vaultId, {
          repoName: 'app1',
          path: '.env',
          overwriteConfirmed: false,
          expected: preview.expected
        })
      )
    ).toBe('LOCAL_CHANGED')
    writeFileSync(join(projA, 'app1', '.env'), 'A=1\n')
    await m.sync.push(key, vaultId, {
      repoName: 'app1',
      path: '.env',
      overwriteConfirmed: false,
      expected: preview.expected
    })
    expect((await rows(m))['app1']).toBe('in-sync')
  })

  it('writes ciphertext only, with no temp files left behind', () => {
    const files = readdirSync(vaultDir).sort()
    expect(files).toEqual(['app1.env.enc', 'meta.json'])
    expect(readFileSync(join(vaultDir, 'app1.env.enc')).includes('A=1')).toBe(false)
  })

  it('detects a local change and pushes version 2', async () => {
    const m = await machine('a')
    writeFileSync(join(projA, 'app1', '.env'), 'A=1\nNEW=2\n')
    expect((await rows(m))['app1']).toBe('local-newer')
    await pushRepo(m, 'app1')
    const { key, vaultId } = await m.open()
    const { rows: list } = await m.sync.listRepos(key, vaultId)
    expect(list.find((r) => r.name === 'app1')?.vault?.version).toBe(2)
  })

  it("lists one repo's row by name, ignoring case (mini mode)", async () => {
    const m = await machine('a')
    const { key, vaultId } = await m.open()
    const all = (await m.sync.listRepos(key, vaultId)).rows
    expect((await m.sync.listRepos(key, vaultId, { only: 'APP1' })).rows).toEqual(
      all.filter((r) => r.name === 'app1')
    )
    expect(await m.sync.listRepos(key, vaultId, { only: 'missing' })).toMatchObject({
      rows: [],
      repos: []
    })
  })

  it('blocks pulls into a repo whose .env is not ignored, until fixed', async () => {
    const m = await machine('a')
    await pushRepo(m, 'app3')
    const { key, vaultId } = await m.open()
    const preview = await m.sync.previewPull(key, vaultId, envFile('app3'))
    expect(preview.ignored).toBe(false)
    expect(
      await errorCode(
        m.sync.pull(key, vaultId, { repoName: 'app3', path: '.env', expected: preview.expected })
      )
    ).toBe('ENV_NOT_IGNORED')
    expect(await m.sync.addGitignore(key, envFile('app3'))).toEqual({
      ignored: true,
      backupIgnored: true,
      tracked: false
    })
    expect(readFileSync(join(projA, 'app3', '.gitignore'), 'utf8')).toBe('.env\n.env.bak.*\n')
    // Idempotent.
    await m.sync.addGitignore(key, envFile('app3'))
    expect(readFileSync(join(projA, 'app3', '.gitignore'), 'utf8')).toBe('.env\n.env.bak.*\n')
  })

  it('reports un-ignored backups in the preview, and the same fix covers them', async () => {
    const m = await machine('a')
    const dir = makeRepo(projA, 'envonly', { '.gitignore': '.env\n', '.env': 'E=1\n' })
    await pushRepo(m, 'envonly')
    writeFileSync(join(dir, '.env'), 'E=2\n')
    const { key, vaultId } = await m.open()
    const preview = await m.sync.previewPull(key, vaultId, envFile('envonly'))
    expect(preview).toMatchObject({ ignored: true, backupIgnored: false, tracked: false })
    expect(
      await errorCode(
        m.sync.pull(key, vaultId, { repoName: 'envonly', path: '.env', expected: preview.expected })
      )
    ).toBe('BACKUP_NOT_IGNORED')
    expect(await m.sync.addGitignore(key, envFile('envonly'))).toMatchObject({
      backupIgnored: true
    })
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe('.env\n.env.bak.*\n')
    rmSync(dir, { recursive: true, force: true })
    rmSync(join(vaultDir, 'envonly.env.enc'))
  })

  it('blocks pulls when .env is tracked by git', async () => {
    const m = await machine('a')
    await pushRepo(m, 'app2')
    git(join(projA, 'app2'), 'add', '-f', '.env')
    const { key, vaultId } = await m.open()
    const preview = await m.sync.previewPull(key, vaultId, envFile('app2'))
    expect(preview.tracked).toBe(true)
    expect(
      await errorCode(
        m.sync.pull(key, vaultId, { repoName: 'app2', path: '.env', expected: preview.expected })
      )
    ).toBe('ENV_TRACKED')
    git(join(projA, 'app2'), 'rm', '-q', '--cached', '.env')
  })
})

describe('machine B: unlock, resolve, push', () => {
  it('rejects a wrong password', async () => {
    const m = await machine('b')
    expect(await errorCode(m.vault.vaultAt(vaultDir).open('wrong password!!'))).toBe(
      'WRONG_PASSWORD'
    )
  })

  it('sees a conflict (never synced here) and vault-only repos', async () => {
    expect(await rows(await machine('b'))).toEqual({
      app1: 'conflict',
      app2: 'vault-only',
      app3: 'vault-only'
    })
  })

  it('pulls (keep vault) with a backup, writing the exact bytes', async () => {
    const m = await machine('b')
    const { key, vaultId } = await m.open()
    const preview = await m.sync.previewPull(key, vaultId, envFile('app1'))
    expect(preview.diff).toEqual({ added: ['NEW'], removed: ['OLD'], changed: [], unchanged: 1 })
    expect(preview.rollback).toBe(false)
    const backup = await pullRepo(m, 'app1')
    expect(backup).toMatch(/^\.env\.bak\.\d{8}T\d{6}Z$/)
    expect(readFileSync(join(projB, 'app1', backup as string), 'utf8')).toBe('A=1\nOLD=x\n')
    expect(readFileSync(join(projB, 'app1', '.env'), 'utf8')).toBe('A=1\nNEW=2\n')
    expect(readdirSync(join(projB, 'app1')).filter((f) => f.includes('tmp'))).toEqual([])
    expect((await rows(m))['app1']).toBe('in-sync')
  })

  it('pushes a change with CRLF and a BOM, byte for byte', async () => {
    const m = await machine('b')
    writeFileSync(join(projB, 'app1', '.env'), '﻿A=1\r\nNEW=2\r\nFROM_B=1\r\n')
    expect((await rows(m))['app1']).toBe('local-newer')
    await pushRepo(m, 'app1')
  })
})

describe('machine A again', () => {
  it('shows the raw diff masked, with values only on request, for the reviewed content', async () => {
    const m = await machine('a')
    const { key, vaultId } = await m.open()
    const preview = await m.sync.previewPull(key, vaultId, envFile('app1'))
    const req = { repoName: 'app1', path: '.env', expected: preview.expected }
    // Local A=1\nNEW=2\n -> B's BOM + CRLF copy: line endings don't count, the BOM does.
    const masked = await m.sync.pullRawDiff(key, { ...req, values: false })
    expect(masked.lines.map((l) => (l.kind === 'gap' ? l : l.text))).toEqual([
      'A=••••••••',
      '\\u{FEFF}A=••••••••',
      'NEW=••••••••',
      'FROM_B=••••••••'
    ])
    const raw = await m.sync.pullRawDiff(key, { ...req, values: true })
    expect(raw.lines).toEqual([
      { kind: 'del', text: 'A=1', oldNo: 1, newNo: null },
      { kind: 'add', text: '\\u{FEFF}A=1', oldNo: null, newNo: 1 },
      { kind: 'same', text: 'NEW=2', oldNo: 2, newNo: 2 },
      { kind: 'add', text: 'FROM_B=1', oldNo: null, newNo: 3 }
    ])

    const stale = { ...preview.expected, vaultHash: 'f'.repeat(64) }
    for (const values of [false, true]) {
      expect(await errorCode(m.sync.pullRawDiff(key, { ...req, expected: stale, values }))).toBe(
        'VAULT_CHANGED'
      )
    }

    const dir = makeRepo(projA, 'novault', { '.gitignore': '.env\n', '.env': 'X=1\n' })
    expect(
      await errorCode(
        m.sync.pullRawDiff(key, {
          repoName: 'novault',
          path: '.env',
          expected: { localHash: null, vaultHash: null },
          values: false
        })
      )
    ).toBe('VAULT_ENTRY_NOT_FOUND')
    rmSync(dir, { recursive: true, force: true })
  })

  it('sees vault-newer and pulls the exact bytes from B', async () => {
    const m = await machine('a')
    expect((await rows(m))['app1']).toBe('vault-newer')
    await pullRepo(m, 'app1')
    expect(readFileSync(join(projA, 'app1', '.env'), 'utf8')).toBe('﻿A=1\r\nNEW=2\r\nFROM_B=1\r\n')
  })

  it('requires confirmation to overwrite a concurrent change', async () => {
    const b = await machine('b')
    writeFileSync(join(projB, 'app1', '.env'), 'A=b-edit\n')
    await pushRepo(b, 'app1')

    const a = await machine('a')
    writeFileSync(join(projA, 'app1', '.env'), 'A=a-edit\n')
    expect((await rows(a))['app1']).toBe('conflict')
    const { key, vaultId } = await a.open()
    const preview = await a.sync.previewPush(key, vaultId, envFile('app1'))
    expect(preview.needsOverwrite).toBe(true)
    expect(preview.diff.changed).toEqual(['A'])
    expect(
      await errorCode(
        a.sync.push(key, vaultId, {
          repoName: 'app1',
          path: '.env',
          overwriteConfirmed: false,
          expected: preview.expected
        })
      )
    ).toBe('OVERWRITE_NOT_CONFIRMED')
    await a.sync.push(key, vaultId, {
      repoName: 'app1',
      path: '.env',
      overwriteConfirmed: true,
      expected: preview.expected
    })
    expect((await rows(a))['app1']).toBe('in-sync')
  })

  it('refuses a pull if the vault changed after the preview', async () => {
    const a = await machine('a')
    const { key, vaultId } = await a.open()
    const preview = await a.sync.previewPull(key, vaultId, envFile('app2'))
    const b = await machine('b')
    // B has no app2 folder, so write the entry by pushing from a temporary repo.
    makeRepo(projB, 'app2', { '.gitignore': '.env\n.env.bak.*\n', '.env': 'B=from-b\n' })
    await pushRepo(b, 'app2', true)
    const a2 = await machine('a')
    expect(
      await errorCode(
        a2.sync.pull(key, vaultId, { repoName: 'app2', path: '.env', expected: preview.expected })
      )
    ).toBe('VAULT_CHANGED')
    rmSync(join(projB, 'app2'), { recursive: true, force: true })
  })
})

describe('hostile or broken vault folders', () => {
  it('reports a tampered entry on its row instead of failing the list', async () => {
    const m = await machine('a')
    const file = join(vaultDir, 'app3.env.enc')
    const bytes = readFileSync(file)
    const original = Buffer.from(bytes)
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1
    writeFileSync(file, bytes)
    const r = await rows(m)
    expect(r['app3']).toBe('error:VAULT_TAMPERED')
    expect(r['app1']).toBe('in-sync')
    writeFileSync(file, original)
  })

  it('rejects a swapped entry (a copied over b)', async () => {
    const m = await machine('a')
    const b = readFileSync(join(vaultDir, 'app2.env.enc'))
    writeFileSync(join(vaultDir, 'app2.env.enc'), readFileSync(join(vaultDir, 'app3.env.enc')))
    expect((await rows(m))['app2']).toBe('error:VAULT_TAMPERED')
    writeFileSync(join(vaultDir, 'app2.env.enc'), b)
  })

  it('rejects weakened or edited meta.json', async () => {
    const m = await machine('a')
    const metaFile = join(vaultDir, 'meta.json')
    const original = readFileSync(metaFile, 'utf8')
    const meta = JSON.parse(original)
    writeFileSync(metaFile, JSON.stringify({ ...meta, kdf: { ...meta.kdf, opslimit: 1 } }))
    expect(await errorCode(m.open())).toBe('META_INVALID')
    writeFileSync(
      metaFile,
      JSON.stringify({ ...meta, vaultId: '00000000-0000-4000-8000-000000000000' })
    )
    expect(await errorCode(m.open())).toBe('WRONG_PASSWORD')
    writeFileSync(metaFile, '{not json')
    expect(await errorCode(m.open())).toBe('META_INVALID')
    writeFileSync(metaFile, original)
  })

  it('refuses to create a new vault over orphaned entries', async () => {
    const m = await machine('a')
    renameSync(join(vaultDir, 'meta.json'), join(root, 'meta.json.bak'))
    expect(await m.vault.vaultAt(vaultDir).state()).toBe('meta-missing')
    expect(await errorCode(m.vault.vaultAt(vaultDir).create(PASSWORD))).toBe('VAULT_META_MISSING')
    renameSync(join(root, 'meta.json.bak'), join(vaultDir, 'meta.json'))
  })

  it('reports a missing vault folder instead of offering to create one', async () => {
    const m = await machine('a')
    expect(await m.vault.vaultAt(join(root, 'no-such-folder')).state()).toBe('folder-missing')
  })

  it('ignores Drive conflict copies and removes only stale temp files of ours', async () => {
    const m = await machine('a')
    writeFileSync(join(vaultDir, 'app1.env (1).enc'), 'junk')
    const stale = join(vaultDir, '.app1.env.enc.0123456789abcdef.tmp')
    const fresh = join(vaultDir, '.app1.env.enc.fedcba9876543210.tmp')
    const foreign = join(vaultDir, '.other-file.tmp')
    for (const f of [stale, fresh, foreign]) writeFileSync(f, 'x')
    const old = new Date(Date.now() - 60 * 60_000)
    utimesSync(stale, old, old)
    utimesSync(foreign, old, old)
    expect(Object.keys(await rows(m)).sort()).toEqual(['app1', 'app2', 'app3'])
    expect(existsSync(stale)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
    expect(existsSync(foreign)).toBe(true)
    for (const f of [fresh, foreign, join(vaultDir, 'app1.env (1).enc')]) rmSync(f)
  })
})

describe('repo edge cases', () => {
  it('treats repo names case-insensitively across machines', async () => {
    const a = await machine('a')
    makeRepo(projA, 'MixedCase', { '.gitignore': '.env\n.env.bak.*\n', '.env': 'M=1\n' })
    await pushRepo(a, 'MixedCase')
    expect(existsSync(join(vaultDir, 'mixedcase.env.enc'))).toBe(true)
    const b = await machine('b')
    makeRepo(projB, 'mixedcase', { '.gitignore': '.env\n.env.bak.*\n', '.env': 'M=1\n' })
    expect((await rows(b))['mixedcase']).toBe('in-sync')
  })

  it.skipIf(process.platform === 'win32')('refuses a symlinked .env', async () => {
    const m = await machine('a')
    const dir = makeRepo(projA, 'linked', { '.gitignore': '.env\n' })
    writeFileSync(join(root, 'outside.txt'), 'SECRET=1\n')
    symlinkSync(join(root, 'outside.txt'), join(dir, '.env'))
    expect((await rows(m))['linked']).toBe('error:ENV_SYMLINK')
  })
})

describe('machine-specific keys', () => {
  const IGNORE = '.env\n.env.bak.*\n'
  const envA = (): string => join(projA, 'local1', '.env')
  const envB = (): string => join(projB, 'local1', '.env')

  const stored = (m: Machine): Promise<string> => storedEnv(m, 'local1')

  it('pushes marked keys blanked, and ignores local edits to them', async () => {
    const a = await machine('a')
    makeRepo(projA, 'local1', {
      '.gitignore': IGNORE,
      '.env': 'SHARED=1\n# envvault:local\nDB_PATH=/a/data\n'
    })
    const { key, vaultId } = await a.open()
    const preview = await a.sync.previewPush(key, vaultId, envFile('local1'))
    expect(preview.kept).toEqual(['DB_PATH'])
    expect(preview.unmarked).toEqual([])
    await pushRepo(a, 'local1')
    expect(await stored(a)).toBe('SHARED=1\n# envvault:local\nDB_PATH=\n')
    expect((await rows(a))['local1']).toBe('in-sync')

    writeFileSync(envA(), 'SHARED=1\n# envvault:local\nDB_PATH=/a/other\n')
    expect((await rows(a))['local1']).toBe('in-sync')
  })

  it("pulls on another machine, keeping that machine's value and adding the marker", async () => {
    const b = await machine('b')
    makeRepo(projB, 'local1', { '.gitignore': IGNORE, '.env': 'SHARED=0\nDB_PATH=C:\\b\\data\n' })
    expect((await rows(b))['local1']).toBe('conflict')
    const { key, vaultId } = await b.open()
    const preview = await b.sync.previewPull(key, vaultId, envFile('local1'))
    expect(preview.kept).toEqual(['DB_PATH'])
    expect(preview.unset).toEqual([])
    expect(preview.sameContent).toBe(false)
    expect(preview.diff).toEqual({ added: [], removed: [], changed: ['SHARED'], unchanged: 1 })

    // The raw diff shows what the pull writes, not the vault copy as stored.
    const raw = await b.sync.pullRawDiff(key, {
      repoName: 'local1',
      path: '.env',
      expected: preview.expected,
      values: true
    })
    expect(raw.lines).toEqual([
      { kind: 'del', text: 'SHARED=0', oldNo: 1, newNo: null },
      { kind: 'add', text: 'SHARED=1', oldNo: null, newNo: 1 },
      { kind: 'add', text: '# envvault:local', oldNo: null, newNo: 2 },
      { kind: 'same', text: 'DB_PATH=C:\\b\\data', oldNo: 2, newNo: 3 }
    ])

    const backup = await pullRepo(b, 'local1')
    expect(readFileSync(join(projB, 'local1', backup as string), 'utf8')).toBe(
      'SHARED=0\nDB_PATH=C:\\b\\data\n'
    )
    expect(readFileSync(envB(), 'utf8')).toBe('SHARED=1\n# envvault:local\nDB_PATH=C:\\b\\data\n')
    expect((await rows(b))['local1']).toBe('in-sync')
  })

  it('syncs shared changes back without touching either machine-specific value', async () => {
    const b = await machine('b')
    writeFileSync(envB(), 'SHARED=2\n# envvault:local\nDB_PATH=C:\\b\\data\n')
    expect((await rows(b))['local1']).toBe('local-newer')
    await pushRepo(b, 'local1')
    expect(await stored(b)).toBe('SHARED=2\n# envvault:local\nDB_PATH=\n')

    const a = await machine('a')
    expect((await rows(a))['local1']).toBe('vault-newer')
    await pullRepo(a, 'local1')
    expect(readFileSync(envA(), 'utf8')).toBe('SHARED=2\n# envvault:local\nDB_PATH=/a/other\n')
    expect((await rows(a))['local1']).toBe('in-sync')
  })

  it('warns before a push would upload a value the vault marks', async () => {
    const a = await machine('a')
    writeFileSync(envA(), 'SHARED=2\nDB_PATH=/a/other\n')
    const { key, vaultId } = await a.open()
    const preview = await a.sync.previewPush(key, vaultId, envFile('local1'))
    expect(preview.kept).toEqual([])
    expect(preview.unmarked).toEqual(['DB_PATH'])
    expect(preview.diff.changed).toEqual(['DB_PATH'])
    writeFileSync(envA(), 'SHARED=2\n# envvault:local\nDB_PATH=/a/other\n')
  })

  it('refuses a marked key that is assigned twice', async () => {
    const a = await machine('a')
    writeFileSync(envA(), 'SHARED=2\n# envvault:local\nDB_PATH=/a\nDB_PATH=/b\n')
    expect((await rows(a))['local1']).toBe('error:ENV_DUPLICATE_KEY')
    const { key, vaultId } = await a.open()
    expect(await errorCode(a.sync.previewPull(key, vaultId, envFile('local1')))).toBe(
      'ENV_DUPLICATE_KEY'
    )
    writeFileSync(envA(), 'SHARED=2\n# envvault:local\nDB_PATH=/a/other\n')
  })

  it('writes a marked key empty where this machine has no value', async () => {
    const b = await machine('b')
    rmSync(envB())
    const { key, vaultId } = await b.open()
    const preview = await b.sync.previewPull(key, vaultId, envFile('local1'))
    expect(preview.kept).toEqual([])
    expect(preview.unset).toEqual(['DB_PATH'])
    await pullRepo(b, 'local1')
    expect(readFileSync(envB(), 'utf8')).toBe('SHARED=2\n# envvault:local\nDB_PATH=\n')
    writeFileSync(envB(), 'SHARED=2\n# envvault:local\nDB_PATH=C:\\b\\new\n')
    expect((await rows(b))['local1']).toBe('in-sync')
  })
})

describe('.env.example checks', () => {
  const IGNORE = '.env\n.env.bak.*\n'
  const TOKEN = 'tok_9f8e7d6c5b4a3210zz'
  const dirA = (): string => join(projA, 'ex1')

  it('reports nothing without a .env.example', async () => {
    const a = await machine('a')
    makeRepo(projA, 'ex1', { '.gitignore': IGNORE, '.env': 'A=1\n' })
    const { key, vaultId } = await a.open()
    expect((await a.sync.previewPush(key, vaultId, envFile('ex1'))).example).toBeNull()
  })

  it('compares the local .env on push, flagging only secret-looking shared values', async () => {
    const a = await machine('a')
    writeFileSync(
      join(dirA(), '.env'),
      `URL=http://localhost:3000\nPORT=3000\nAPI_TOKEN=${TOKEN}\n# envvault:local\nDB_PATH=/a/data\nEXTRA=1\n`
    )
    writeFileSync(
      join(dirA(), '.env.example'),
      `URL=http://localhost:3000\nPORT=3000\nAPI_TOKEN=${TOKEN}\nDB_PATH=\nREDIS_URL=\n# OPTIONAL=\n`
    )
    const { key, vaultId } = await a.open()
    expect((await a.sync.previewPush(key, vaultId, envFile('ex1'))).example).toEqual({
      status: 'ok',
      tracked: false,
      sameValue: ['API_TOKEN'],
      missing: ['REDIS_URL'],
      undocumented: ['EXTRA']
    })
    git(dirA(), 'add', '.env.example')
    expect((await a.sync.previewPush(key, vaultId, envFile('ex1'))).example).toMatchObject({
      tracked: true
    })
    await pushRepo(a, 'ex1')
  })

  it('compares what the pull writes, including kept machine-specific keys', async () => {
    const b = await machine('b')
    makeRepo(projB, 'ex1', {
      '.gitignore': IGNORE,
      '.env': 'DB_PATH=C:\\b\n# envvault:local\nB_ONLY=x\n',
      '.env.example': 'DB_PATH=\nB_ONLY=\nREDIS_URL=\nAPI_TOKEN=\n'
    })
    const { key, vaultId } = await b.open()
    const preview = await b.sync.previewPull(key, vaultId, envFile('ex1'))
    // B_ONLY isn't in the vault copy, but the pull keeps it, so it isn't missing.
    expect(preview.kept).toEqual(['B_ONLY', 'DB_PATH'])
    expect(preview.example).toEqual({
      status: 'ok',
      tracked: null,
      sameValue: [],
      missing: ['REDIS_URL'],
      undocumented: ['EXTRA', 'PORT', 'URL']
    })
  })

  it.skipIf(process.platform === 'win32')(
    'reports an unreadable .env.example without failing the preview',
    async () => {
      const a = await machine('a')
      rmSync(join(dirA(), '.env.example'))
      writeFileSync(join(root, 'outside-example'), 'X=1\n')
      symlinkSync(join(root, 'outside-example'), join(dirA(), '.env.example'))
      const { key, vaultId } = await a.open()
      expect((await a.sync.previewPush(key, vaultId, envFile('ex1'))).example).toEqual({
        status: 'unreadable',
        message: '.env.example is a symlink, which EnvVault refuses to follow.'
      })
      rmSync(join(dirA(), '.env.example'))
    }
  )

  it('is on by default and skipped when turned off', async () => {
    const b = await machine('b')
    expect((await b.config.getConfig()).checkExample).toBe(true)
    await b.config.updateConfig({ checkExample: false })
    const { key, vaultId } = await b.open()
    expect((await b.sync.previewPull(key, vaultId, envFile('ex1'))).example).toBeNull()
    expect((await b.sync.previewPush(key, vaultId, envFile('ex1'))).example).toBeNull()
    await b.config.updateConfig({ checkExample: true })
  })
})

describe('editing the vault copy', () => {
  const IGNORE = '.env\n.env.bak.*\n'
  const envA = (): string => join(projA, 'ed1', '.env')
  const ORIGINAL =
    '# shared\r\nexport API_URL=https://api.example.com\r\nSECRET="s3cret value" # rotate\r\n' +
    '# envvault:local\r\nDB_PATH=/a/data\r\nOLD=1\r\n'

  const stored = (m: Machine, repoName: string): Promise<string> => storedEnv(m, repoName)

  it('opens the vault copy as rows, with machine-specific values empty', async () => {
    const a = await machine('a')
    makeRepo(projA, 'ed1', { '.gitignore': IGNORE, '.env': ORIGINAL })
    await pushRepo(a, 'ed1')
    const { key } = await a.open()
    const data = await a.sync.openEditor(key, envFile('ed1'))
    expect(data.entries).toEqual([
      { key: 'API_URL', value: 'https://api.example.com', marked: false },
      { key: 'SECRET', value: 's3cret value', marked: false },
      { key: 'DB_PATH', value: '', marked: true },
      { key: 'OLD', value: '1', marked: false }
    ])
    expect(data.vault?.version).toBe(1)
    expect(data.expectedVaultHash).toBe(data.vault?.contentHash)
  })

  it('saves edits to the vault copy only; a pull then brings them, keeping local values', async () => {
    const a = await machine('a')
    const { key, vaultId } = await a.open()
    const { expectedVaultHash } = await a.sync.openEditor(key, envFile('ed1'))
    const result = await a.sync.saveEdit(key, vaultId, {
      repoName: 'ed1',
      path: '.env',
      expectedVaultHash,
      set: [{ key: 'SECRET', value: 'new # secret' }],
      add: [{ key: 'NEW_KEY', value: 'line1\nline2' }],
      remove: ['OLD'],
      mark: []
    })
    expect(result).toMatchObject({ changed: true, vault: { version: 2 } })
    const edited =
      "# shared\r\nexport API_URL=https://api.example.com\r\nSECRET='new # secret' # rotate\r\n" +
      "# envvault:local\r\nDB_PATH=\r\nNEW_KEY='line1\r\nline2'\r\n"
    expect(await stored(a, 'ed1')).toBe(edited)
    expect(readFileSync(envA(), 'utf8')).toBe(ORIGINAL)
    expect((await rows(a))['ed1']).toBe('vault-newer')

    await pullRepo(a, 'ed1')
    expect(readFileSync(envA(), 'utf8')).toBe(edited.replace('DB_PATH=\r\n', 'DB_PATH=/a/data\r\n'))
    expect((await rows(a))['ed1']).toBe('in-sync')
  })

  it('refuses to save over a vault copy that changed after the editor opened', async () => {
    const a = await machine('a')
    const opened = await a.sync.openEditor((await a.open()).key, envFile('ed1'))
    const b = await machine('b')
    makeRepo(projB, 'ed1', { '.gitignore': IGNORE, '.env': 'FROM_B=1\n' })
    await pushRepo(b, 'ed1', true)

    const a2 = await machine('a')
    const { key, vaultId } = await a2.open()
    const save = a2.sync.saveEdit(key, vaultId, {
      repoName: 'ed1',
      path: '.env',
      expectedVaultHash: opened.expectedVaultHash,
      set: [],
      add: [{ key: 'X', value: '1' }],
      remove: [],
      mark: []
    })
    expect(await errorCode(save)).toBe('VAULT_CHANGED')
  })

  it('reports a save that changes nothing without writing a version', async () => {
    const a = await machine('a')
    const { key, vaultId } = await a.open()
    const opened = await a.sync.openEditor(key, envFile('ed1'))
    const result = await a.sync.saveEdit(key, vaultId, {
      repoName: 'ed1',
      path: '.env',
      expectedVaultHash: opened.expectedVaultHash,
      set: [{ key: 'FROM_B', value: '1' }],
      add: [],
      remove: [],
      mark: []
    })
    expect(result).toEqual({ vault: opened.vault, changed: false })
  })

  it('creates a vault copy for a repo with no .env', async () => {
    const a = await machine('a')
    makeRepo(projA, 'ed2', { '.gitignore': IGNORE })
    const { key, vaultId } = await a.open()
    expect(await a.sync.openEditor(key, envFile('ed2'))).toEqual({
      entries: [],
      vault: null,
      expectedVaultHash: null
    })
    const empty = {
      repoName: 'ed2',
      path: '.env',
      expectedVaultHash: null,
      set: [],
      add: [],
      remove: [],
      mark: []
    }
    expect(await a.sync.saveEdit(key, vaultId, empty)).toEqual({ vault: null, changed: false })
    const result = await a.sync.saveEdit(key, vaultId, {
      ...empty,
      add: [{ key: 'API_KEY', value: 'abc' }]
    })
    expect(result.vault?.version).toBe(1)
    expect(await stored(a, 'ed2')).toBe('API_KEY=abc\n')
    expect(existsSync(join(projA, 'ed2', '.env'))).toBe(false)
    expect((await rows(a))['ed2']).toBe('vault-newer')
  })

  it('refuses duplicated keys and bad edits, without echoing them', async () => {
    const a = await machine('a')
    makeRepo(projA, 'ed3', { '.gitignore': IGNORE, '.env': 'A=1\nA=2\n' })
    await pushRepo(a, 'ed3')
    const { key, vaultId } = await a.open()
    expect(await errorCode(a.sync.openEditor(key, envFile('ed3')))).toBe('ENV_DUPLICATE_KEY')

    const opened = await a.sync.openEditor(key, envFile('ed2'))
    const err = await a.sync
      .saveEdit(key, vaultId, {
        repoName: 'ed2',
        path: '.env',
        expectedVaultHash: opened.expectedVaultHash,
        set: [{ key: 'MISSING_SECRET_KEY', value: 'hunter2-secret' }],
        add: [],
        remove: [],
        mark: []
      })
      .catch((e: unknown) => e as { code?: string; message?: string })
    expect(err).toMatchObject({ code: 'EDIT_INVALID' })
    expect(JSON.stringify(err)).not.toMatch(/MISSING_SECRET_KEY|hunter2/)
    expect(String((err as { message?: string }).message)).not.toMatch(/MISSING_SECRET_KEY|hunter2/)
  })
})

describe('automatic pull', () => {
  const IGNORE = '.env\n.env.bak.*\n'
  const envA = (repo: string): string => join(projA, repo, '.env')
  const envB = (repo: string): string => join(projB, repo, '.env')
  const backups = (repo: string): string[] =>
    readdirSync(join(projB, repo)).filter((f) => f.startsWith('.env.bak.'))

  it('pulls a one-sided vault change, keeping machine-specific values', async () => {
    const a = await machine('a')
    makeRepo(projA, 'ap1', { '.gitignore': IGNORE, '.env': 'A=1\n# envvault:local\nDB=/a\n' })
    await pushRepo(a, 'ap1')
    const b = await machine('b')
    makeRepo(projB, 'ap1', { '.gitignore': IGNORE, '.env': 'A=1\n# envvault:local\nDB=/b\n' })
    expect((await rows(b))['ap1']).toBe('in-sync')

    const a2 = await machine('a')
    writeFileSync(envA('ap1'), 'A=2\n# envvault:local\nDB=/a\n')
    await pushRepo(a2, 'ap1')

    const b2 = await machine('b')
    const { key, vaultId } = await b2.open()
    expect(await b2.sync.autoPull(key, vaultId, envFile('ap1'))).toMatchObject({
      name: 'ap1',
      status: 'in-sync',
      hasEnv: true,
      vault: { version: 2 }
    })
    expect(readFileSync(envB('ap1'), 'utf8')).toBe('A=2\n# envvault:local\nDB=/b\n')
    expect(backups('ap1')).toHaveLength(1)
    expect((await rows(b2))['ap1']).toBe('in-sync')
    expect(await b2.sync.autoPull(key, vaultId, envFile('ap1'))).toBeNull()
  })

  it('leaves a conflict and a rollback alone', async () => {
    writeFileSync(envB('ap1'), 'A=2\nB_ONLY=1\n# envvault:local\nDB=/b\n')
    const a = await machine('a')
    writeFileSync(envA('ap1'), 'A=3\n# envvault:local\nDB=/a\n')
    await pushRepo(a, 'ap1')

    const b2 = await machine('b')
    const { key, vaultId } = await b2.open()
    expect((await rows(b2))['ap1']).toBe('conflict')
    expect(await b2.sync.autoPull(key, vaultId, envFile('ap1'))).toBeNull()
    expect(readFileSync(envB('ap1'), 'utf8')).toBe('A=2\nB_ONLY=1\n# envvault:local\nDB=/b\n')

    // Resolve by hand (keep vault), then let v4 arrive automatically.
    await pullRepo(b2, 'ap1')
    const entry = join(vaultDir, 'ap1.env.enc')
    const v3 = readFileSync(entry)
    const a2 = await machine('a')
    writeFileSync(envA('ap1'), 'A=4\n# envvault:local\nDB=/a\n')
    await pushRepo(a2, 'ap1')
    const b3 = await machine('b')
    const k3 = await b3.open()
    expect(await b3.sync.autoPull(k3.key, k3.vaultId, envFile('ap1'))).toMatchObject({
      vault: { version: 4 }
    })

    // Someone puts v3 back: that's a rollback, never pulled automatically.
    writeFileSync(entry, v3)
    expect((await rows(b3))['ap1']).toBe('conflict')
    expect(await b3.sync.autoPull(k3.key, k3.vaultId, envFile('ap1'))).toBeNull()
    expect(readFileSync(envB('ap1'), 'utf8')).toBe('A=4\n# envvault:local\nDB=/b\n')
  })

  it('skips a repo whose .env is not git-ignored', async () => {
    const a = await machine('a')
    makeRepo(projA, 'ap2', { '.gitignore': IGNORE, '.env': 'X=1\n' })
    await pushRepo(a, 'ap2')
    const b = await machine('b')
    makeRepo(projB, 'ap2', {})
    const { key, vaultId } = await b.open()
    expect((await rows(b))['ap2']).toBe('vault-newer')
    expect(await b.sync.autoPull(key, vaultId, envFile('ap2'))).toBeNull()
    expect(existsSync(envB('ap2'))).toBe(false)
  })

  it('creates a missing .env, both for a new clone and after it was deleted', async () => {
    const b = await machine('b')
    writeFileSync(join(projB, 'ap2', '.gitignore'), IGNORE)
    const { key, vaultId } = await b.open()
    expect(await b.sync.autoPull(key, vaultId, envFile('ap2'))).toMatchObject({ status: 'in-sync' })
    expect(readFileSync(envB('ap2'), 'utf8')).toBe('X=1\n')

    rmSync(envB('ap2'))
    expect((await rows(b))['ap2']).toBe('vault-newer')
    expect(await b.sync.autoPull(key, vaultId, envFile('ap2'))).toMatchObject({ status: 'in-sync' })
    expect(readFileSync(envB('ap2'), 'utf8')).toBe('X=1\n')
  })

  it('runs a pass only while unlocked and with the setting on (off by default)', async () => {
    const a = await machine('a')
    writeFileSync(envA('ap2'), 'X=2\n')
    await pushRepo(a, 'ap2')

    const b = await machine('b')
    expect((await b.config.getConfig()).autoPull).toBe(false)
    expect(await b.autopull.runAutoPull()).toEqual([])

    const { key, vaultId } = await b.open()
    b.session.unlock(key, vaultId, 5)
    try {
      await b.config.updateConfig({ autoPull: false })
      expect(await b.autopull.runAutoPull()).toEqual([])
      expect(readFileSync(envB('ap2'), 'utf8')).toBe('X=1\n')

      await b.config.updateConfig({ autoPull: true })
      const pulled = await b.autopull.runAutoPull()
      expect(pulled.map((r) => r.name)).toContain('ap2')
      expect(pulled.every((r) => r.status === 'in-sync')).toBe(true)
      expect(readFileSync(envB('ap2'), 'utf8')).toBe('X=2\n')
    } finally {
      b.session.lock()
    }
    expect(await b.autopull.runAutoPull()).toEqual([])
  })
})

describe('backups', () => {
  const IGNORE = '.env\n.env.bak.*\n'
  const repoB = (): string => join(projB, 'bk1')
  const files = (): string[] =>
    readdirSync(repoB())
      .filter((f) => f.startsWith('.env.bak.'))
      .sort()

  afterAll(async () => {
    const b = await machine('b')
    await b.config.updateConfig({ backups: true, backupCount: 3 })
  })

  it('are on by default and keep the newest few, leaving files that are not backups', async () => {
    const a = await machine('a')
    makeRepo(projA, 'bk1', { '.gitignore': IGNORE, '.env': 'K=1\n' })
    await pushRepo(a, 'bk1')
    const b = await machine('b')
    expect(await b.config.getConfig()).toMatchObject({ backups: true, backupCount: 3 })
    makeRepo(projB, 'bk1', {
      '.gitignore': IGNORE,
      '.env': 'K=local\n',
      '.env.bak.20200101T000000Z': 'old 1',
      '.env.bak.20200102T000000Z': 'old 2',
      '.env.bak.20200102T000000Z-ab12': 'old 3',
      '.env.bak.mine': 'not a backup',
      '.env.bak.tmp-0000000000000000': 'a pull in progress'
    })
    await b.config.updateConfig({ backupCount: 2 })

    const backup = (await pullRepo(b, 'bk1')) ?? ''
    expect(backup).toMatch(/^\.env\.bak\.\d{8}T\d{6}Z$/)
    expect(readFileSync(join(repoB(), backup), 'utf8')).toBe('K=local\n')
    expect(files()).toEqual(
      [
        backup,
        '.env.bak.20200102T000000Z-ab12',
        '.env.bak.mine',
        '.env.bak.tmp-0000000000000000'
      ].sort()
    )
  })

  it('are not written when turned off', async () => {
    const a = await machine('a')
    writeFileSync(join(projA, 'bk1', '.env'), 'K=2\n')
    await pushRepo(a, 'bk1')
    const b = await machine('b')
    await b.config.updateConfig({ backups: false })
    const before = files()

    expect(await pullRepo(b, 'bk1')).toBeNull()
    expect(readFileSync(join(repoB(), '.env'), 'utf8')).toBe('K=2\n')
    expect(files()).toEqual(before)
  })
})

describe('command line', () => {
  const IGNORE = '.env\n.env.bak.*\n'
  const pushed: RepoRow[] = []

  /** Machine `name`, unlocked, with the envvault command's table. */
  async function unlocked(name: 'a' | 'b'): Promise<{ m: Machine; cli: CliTable }> {
    const m = await machine(name)
    const { key, vaultId } = await m.open()
    m.session.unlock(key, vaultId, 5)
    return { m, cli: m.clicommands.cliCommands((row) => pushed.push(row)) }
  }

  it('is off by default, and needs the vault unlocked', async () => {
    const m = await machine('a')
    expect((await m.config.getConfig()).cliAccess).toBe(false)
    const cli = m.clicommands.cliCommands(() => undefined)
    expect(await errorCode(cli.status.run({ all: true }))).toBe('LOCKED')
  })

  it('finds the repo from any folder inside it', async () => {
    makeRepo(projA, 'cl1', { '.gitignore': IGNORE, '.env': 'K=1\n' })
    mkdirSync(join(projA, 'cl1', 'src', 'deep'), { recursive: true })
    const { m, cli } = await unlocked('a')
    try {
      for (const dir of [join(projA, 'cl1'), join(projA, 'cl1', 'src', 'deep')]) {
        expect((await cli.status.run({ dir })).rows).toMatchObject([
          { name: 'cl1', status: 'local-only' }
        ])
      }
      expect((await cli.status.run({ repo: 'CL1' })).rows).toMatchObject([{ name: 'cl1' }])
      expect((await cli.status.run({ all: true })).rows.map((r) => r.name)).toContain('cl1')
      for (const dir of [root, projA, join(projA, 'not-a-repo'), join(projA, 'cl1', 'missing')]) {
        expect(await errorCode(cli.status.run({ dir }))).toBe('REPO_NOT_FOUND')
      }
      expect(await errorCode(cli.status.run({ repo: 'nope' }))).toBe('REPO_NOT_FOUND')
    } finally {
      m.session.lock()
    }
  })

  it('uses the nearest .env at or above the folder, in a monorepo', async () => {
    const dir = makeRepo(projA, 'cl2', { '.gitignore': IGNORE, '.env': 'ROOT=1\n' })
    mkdirSync(join(dir, 'packages', 'a', 'src'), { recursive: true })
    mkdirSync(join(dir, 'packages', 'b', 'src'), { recursive: true })
    mkdirSync(join(dir, 'packages', 'has space'), { recursive: true })
    writeFileSync(join(dir, 'packages', 'a', '.env'), 'A=1\n')
    writeFileSync(join(dir, 'packages', 'has space', '.env'), 'S=1\n')
    const { m, cli } = await unlocked('a')
    try {
      const at = async (...folders: string[]): Promise<string> =>
        (await cli.previewPush.run({ dir: join(dir, ...folders) })).path
      expect(await at('packages', 'a', 'src')).toBe('packages/a/.env')
      expect(await at('packages', 'a')).toBe('packages/a/.env')
      expect(await at('packages', 'b', 'src')).toBe('.env')
      // A folder EnvVault doesn't sync from is passed over.
      expect(await at('packages', 'has space')).toBe('.env')
      expect(await at()).toBe('.env')
      const named = await cli.previewPush.run({ repo: 'cl2', path: 'packages/a/.env' })
      expect(named).toMatchObject({ repo: 'cl2', path: 'packages/a/.env' })
      expect(named.preview.diff.added).toEqual(['A'])
      // Status lists every .env of the repo, found by git.
      expect(
        (await cli.status.run({ dir: join(dir, 'packages', 'a', 'src') })).rows.map((r) => r.path)
      ).toEqual(['.env', 'packages/a/.env'])
    } finally {
      m.session.lock()
    }
  })

  it('pushes a one-sided change, and reports only pushes that changed the vault', async () => {
    const { m, cli } = await unlocked('a')
    try {
      const dir = join(projA, 'cl1', 'src')
      const { repo, preview } = await cli.previewPush.run({ dir })
      expect(repo).toBe('cl1')
      expect(preview.diff.added).toEqual(['K'])
      const row = await cli.push.run({ dir, expected: preview.expected })
      expect(row).toMatchObject({ name: 'cl1', status: 'in-sync', vault: { version: 1 } })
      expect(pushed.map((r) => r.name)).toEqual(['cl1'])

      const again = await cli.previewPush.run({ repo: 'cl1' })
      expect(again.preview.sameContent).toBe(true)
      await cli.push.run({ repo: 'cl1', expected: again.preview.expected })
      expect(pushed).toHaveLength(1)

      // The token from a preview goes stale when the file changes.
      writeFileSync(join(projA, 'cl1', '.env'), 'K=2\n')
      expect(await errorCode(cli.push.run({ repo: 'cl1', expected: again.preview.expected }))).toBe(
        'LOCAL_CHANGED'
      )
      const next = await cli.previewPush.run({ repo: 'cl1' })
      expect(await cli.push.run({ repo: 'cl1', expected: next.preview.expected })).toMatchObject({
        vault: { version: 2 }
      })
      expect(pushed).toHaveLength(2)
    } finally {
      m.session.lock()
    }
  })

  it('refuses to overwrite a vault copy that changed elsewhere', async () => {
    makeRepo(projB, 'cl1', { '.gitignore': IGNORE, '.env': 'K=2\n' })
    expect((await rows(await machine('b')))['cl1']).toBe('in-sync')
    const a = await machine('a')
    writeFileSync(join(projA, 'cl1', '.env'), 'K=3\n')
    await pushRepo(a, 'cl1')

    writeFileSync(join(projB, 'cl1', '.env'), 'K=4\n')
    const { m, cli } = await unlocked('b')
    try {
      const { preview } = await cli.previewPush.run({ repo: 'cl1' })
      expect(preview.needsOverwrite).toBe(true)
      const entry = join(vaultDir, 'cl1.env.enc')
      const before = readFileSync(entry)
      const err = await cli.push.run({ repo: 'cl1', expected: preview.expected }).catch((e) => e)
      expect(err).toMatchObject({
        code: 'OVERWRITE_NOT_CONFIRMED',
        message: 'The vault copy changed on another machine. Resolve it in EnvVault.'
      })
      expect(readFileSync(entry).equals(before)).toBe(true)
      expect(pushed).toHaveLength(2)
    } finally {
      m.session.lock()
    }
  })
})

describe('the configured vault', () => {
  it('comes from Settings, and is required wherever a vault is needed', async () => {
    const m = await machine('a')
    expect(await (await m.vault.requireVault()).state()).toBe('ready')
    await m.config.updateConfig({ vault: null })
    try {
      expect(await m.vault.configuredVault()).toBeNull()
      expect(await errorCode(m.vault.requireVault())).toBe('NOT_CONFIGURED')
      expect(await errorCode(m.sync.listRepos(new Uint8Array(32), 'any'))).toBe('NOT_CONFIGURED')
    } finally {
      await m.config.updateConfig({ vault: { kind: 'folder', path: vaultDir } })
    }
    expect(await (await m.vault.configuredVault())?.state()).toBe('ready')
  })
})

describe('session', () => {
  it('gives each operation its own key copy, so locking mid-operation is safe', async () => {
    const m = await machine('a')
    const { key, vaultId } = await m.open()
    m.session.unlock(key, vaultId, 5)
    await m.session.withKey(async (copy) => {
      m.session.lock()
      expect(copy.some((b) => b !== 0)).toBe(true)
    })
    expect(key.every((b) => b === 0)).toBe(true)
    expect(m.session.isUnlocked()).toBe(false)
    expect(await errorCode(m.session.withKey(async () => null))).toBe('LOCKED')
  })
})

describe('state.json', () => {
  it('keeps each vault separately and loses no concurrent write', async () => {
    await machine('a')
    const state = await import('../src/main/state')
    const H = 'a'.repeat(64)
    await Promise.all([
      state.setLast('vault-1', 'x', { version: 1, contentHash: H }),
      state.setLast('vault-1', 'y', { version: 2, contentHash: H }),
      state.setLast('vault-2', 'x', { version: 9, contentHash: H })
    ])
    vi.resetModules()
    const fresh = await import('../src/main/state')
    expect(await fresh.getLast('vault-1', 'x')).toEqual({ version: 1, contentHash: H })
    expect(await fresh.getLast('vault-1', 'y')).toEqual({ version: 2, contentHash: H })
    expect(await fresh.getLast('vault-2', 'x')).toEqual({ version: 9, contentHash: H })
    // Prototype keys are never treated as records.
    expect(await fresh.getLast('vault-1', 'constructor')).toBeNull()
    expect(await fresh.getLast('constructor', 'x')).toBeNull()
  })
})

describe('git resolution', () => {
  it('never runs a git binary planted in the repo, even with "." on PATH', async () => {
    const dir = makeRepo(projA, 'planted', { '.gitignore': '.env\n' })
    const marker = join(root, 'planted-ran')
    if (process.platform === 'win32') {
      // Any real executable will do; whoami fails on git's arguments.
      copyFileSync('C:\\Windows\\System32\\whoami.exe', join(dir, 'git.exe'))
    } else {
      writeFileSync(join(dir, 'git'), `#!/bin/sh\ntouch "${marker}"\nexit 3\n`)
      chmodSync(join(dir, 'git'), 0o755)
    }
    const savedPath = process.env['PATH']
    process.env['PATH'] = `.${delimiter}${savedPath ?? ''}`
    try {
      vi.resetModules()
      const git = await import('../src/main/git')
      expect(await git.checkIgnored(dir, '.env')).toBe(true)
      expect(await git.isTracked(dir, '.env')).toBe(false)
      expect(existsSync(marker)).toBe(false)
    } finally {
      process.env['PATH'] = savedPath
    }
  })
})

// Many git processes per test, which start slowly on Windows.
describe('git vault', { timeout: 30_000 }, () => {
  const IGNORE = '.env\n.env.bak.*\n'
  let remote: string
  let location: VaultLocation
  let gpA: string
  let gpB: string
  const on = (name: 'a' | 'b'): Promise<Machine> =>
    machine(name, { projects: name === 'a' ? gpA : gpB, vault: location })
  const inRemote = (...args: string[]): string =>
    execFileSync('git', ['--git-dir', remote, ...args], { encoding: 'utf8' }).trim()

  beforeAll(() => {
    remote = join(root, 'vault-remote.git')
    execFileSync('git', ['init', '--bare', '--quiet', remote])
    location = { kind: 'git', url: remote, branch: 'main' }
    gpA = join(root, 'git-projects-a')
    gpB = join(root, 'git-projects-b')
    makeRepo(gpA, 'gv1', { '.gitignore': IGNORE, '.env': 'A=1\n# envvault:local\nDB=/a\n' })
    makeRepo(gpB, 'gv1', { '.gitignore': IGNORE })
  })

  it('syncs between two machines: push, pull, edit, automatic pull', async () => {
    const a = await on('a')
    expect(await a.vault.vaultFor(location).state()).toBe('empty')
    // Always format 2 in a git repository, even when not asked for.
    const created = await a.vault.vaultFor(location).create(PASSWORD)
    expect(created.setupCode).toMatch(/^EV-/)
    h.setupCode = created.setupCode ?? undefined
    expect(await a.vault.vaultFor(location).state()).toBe('ready')
    expect(await a.vault.vaultFor(location).setupCodeState()).toBe('saved')
    expect(JSON.parse(inRemote('show', 'main:meta.json'))).toMatchObject({ formatVersion: 2 })
    await pushRepo(a, 'gv1')
    expect((await rows(a))['gv1']).toBe('in-sync')

    const b = await on('b')
    expect(await b.vault.vaultFor(location).setupCodeState()).toBe('needed')
    expect(await errorCode(b.vault.vaultFor(location).open(PASSWORD))).toBe('SETUP_CODE_REQUIRED')
    expect((await rows(b))['gv1']).toBe('vault-newer')
    expect(await b.vault.vaultFor(location).setupCodeState()).toBe('saved')
    await pullRepo(b, 'gv1')
    expect(readFileSync(join(gpB, 'gv1', '.env'), 'utf8')).toBe('A=1\n# envvault:local\nDB=\n')

    const { key, vaultId } = await b.open()
    const editor = await b.sync.openEditor(key, envFile('gv1'))
    const saved = await b.sync.saveEdit(key, vaultId, {
      repoName: 'gv1',
      path: '.env',
      expectedVaultHash: editor.expectedVaultHash,
      set: [{ key: 'A', value: '2' }],
      add: [],
      remove: [],
      mark: []
    })
    expect(saved).toMatchObject({
      changed: true,
      vault: { version: 2, updatedBy: expect.any(String) }
    })

    const a2 = await on('a')
    await a2.config.updateConfig({ autoPull: true })
    const opened = await a2.open()
    a2.session.unlock(opened.key, opened.vaultId, 5)
    try {
      expect((await a2.autopull.runAutoPull()).map((r) => r.name)).toEqual(['gv1'])
    } finally {
      a2.session.lock()
    }
    expect(readFileSync(join(gpA, 'gv1', '.env'), 'utf8')).toBe('A=2\n# envvault:local\nDB=/a\n')

    // The repository holds ciphertext only, committed by EnvVault.
    expect(inRemote('ls-tree', '--name-only', 'main').split('\n').sort()).toEqual([
      'gv1.env.enc',
      'meta.json'
    ])
    expect(inRemote('log', '--format=%an <%ae>', 'main').split('\n')).toEqual(
      Array(3).fill('EnvVault <envvault@users.noreply.invalid>')
    )
    expect(inRemote('show', 'main:gv1.env.enc')).not.toContain('A=2')
  })

  it('refuses a push over a copy another machine changed after it was reviewed', async () => {
    const a = await on('a')
    writeFileSync(join(gpA, 'gv1', '.env'), 'A=3\n# envvault:local\nDB=/a\n')
    const ka = await a.open()
    const preview = await a.sync.previewPush(ka.key, ka.vaultId, envFile('gv1'))

    const b = await on('b')
    writeFileSync(join(gpB, 'gv1', '.env'), 'A=4\n# envvault:local\nDB=\n')
    // b never pulled the edit it made, so this overwrites it.
    await pushRepo(b, 'gv1', true)

    const a2 = await on('a')
    const ka2 = await a2.open()
    expect(
      await errorCode(
        a2.sync.push(ka2.key, ka2.vaultId, {
          repoName: 'gv1',
          path: '.env',
          overwriteConfirmed: true,
          expected: preview.expected
        })
      )
    ).toBe('VAULT_CHANGED')
  })

  it('syncs an .env in a folder through the repository', async () => {
    const a = await on('a')
    mkdirSync(join(gpA, 'gv1', 'apps', 'web'), { recursive: true })
    writeFileSync(join(gpA, 'gv1', 'apps', 'web', '.env'), 'WEB=1\n')
    await pushRepo(a, 'gv1', false, 'apps/web/.env')
    const tree = inRemote('ls-tree', '--name-only', 'main').split('\n')
    expect(tree.filter((name) => name.endsWith('.file.enc'))).toEqual([
      expect.stringMatching(/^gv1\.[0-9a-f]{16}\.file\.enc$/)
    ])
    expect(tree.join(' ')).not.toContain('web')

    const b = await on('b')
    mkdirSync(join(gpB, 'gv1', 'apps', 'web'), { recursive: true })
    expect((await rows(b))['gv1/apps/web/.env']).toBe('vault-newer')
    await pullRepo(b, 'gv1', 'apps/web/.env')
    expect(readFileSync(join(gpB, 'gv1', 'apps', 'web', '.env'), 'utf8')).toBe('WEB=1\n')
  })

  it('reports an unreachable repository', async () => {
    const m = await machine('a', {
      projects: gpA,
      vault: { kind: 'git', url: join(root, 'no-such-remote.git'), branch: 'main' }
    })
    expect(await (await m.vault.requireVault()).state()).toBe('folder-missing')
    expect(await errorCode(m.open())).toBe('GIT_VAULT_UNREACHABLE')
  })
})

// A monorepo: a .env in its packages as well as at its root, found by git.
// Its own vault folder, so other tests never see its entries.
describe('monorepo', { timeout: 30_000 }, () => {
  const IGNORE = '.env\n.env.bak.*\nnode_modules/\n'
  const WEB = envFile('platform', 'apps/web/.env')
  const API = envFile('platform', 'apps/api/.env')
  let monoVault: string
  let location: VaultLocation
  let mpA: string
  let mpB: string
  let dirA: string
  let dirB: string
  const on = (name: 'a' | 'b'): Promise<Machine> =>
    machine(name, { projects: name === 'a' ? mpA : mpB, vault: location })
  const write = (dir: string, file: string, text: string): void => {
    mkdirSync(join(dir, file, '..'), { recursive: true })
    writeFileSync(join(dir, file), text)
  }
  const entries = (): string[] =>
    readdirSync(monoVault)
      .filter((name) => name.endsWith('.enc'))
      .sort()
  const backupsIn = (dir: string): string[] =>
    readdirSync(dir).filter((name) => name.startsWith('.env.bak.'))

  beforeAll(async () => {
    monoVault = join(root, 'mono-vault')
    mkdirSync(monoVault)
    location = { kind: 'folder', path: monoVault }
    mpA = join(root, 'mono-a')
    mpB = join(root, 'mono-b')
    dirA = makeRepo(mpA, 'platform', { '.gitignore': IGNORE, '.env': 'ROOT=1\n' })
    write(dirA, WEB.path, 'WEB=1\n')
    write(dirA, API.path, 'API=1\n')
    write(dirA, 'node_modules/dep/.env', 'DEP=1\n')
    // Backups must be ignored too, and this folder says otherwise.
    write(dirA, 'apps/docs/.env', 'DOCS=1\n')
    write(dirA, 'apps/docs/.gitignore', '!.env.bak.*\n')
    // One that git would commit, and one committed by mistake.
    write(dirA, 'tools/open/.gitignore', '!.env\n')
    write(dirA, 'tools/open/.env', 'OPEN=1\n')
    write(dirA, 'tools/tracked/.env', 'TRACKED=1\n')
    git(dirA, 'add', '-f', 'tools/tracked/.env')
    dirB = makeRepo(mpB, 'platform', { '.gitignore': IGNORE })
    mkdirSync(join(dirB, 'apps', 'web'), { recursive: true })
    await (await on('a')).vault.vaultFor(location).create(PASSWORD)
  })

  it('finds every .env git reports, none in ignored folders, and asks git only when told to', async () => {
    const a = await on('a')
    expect(await rows(a)).toEqual({ platform: 'local-only' })
    const found = {
      platform: 'local-only',
      'platform/apps/api/.env': 'local-only',
      'platform/apps/docs/.env': 'local-only',
      'platform/apps/web/.env': 'local-only',
      'platform/tools/open/.env': 'local-only',
      'platform/tools/tracked/.env': 'local-only'
    }
    expect(await rows(a, true)).toEqual(found)
    // Remembered, so background work lists them without running git.
    expect(await rows(a)).toEqual(found)
  })

  it('pushes an .env in a folder under a name that hides its path, and pulls it elsewhere', async () => {
    const a = await on('a')
    await pushRepo(a, 'platform', false, WEB.path)
    expect(entries()).toEqual([expect.stringMatching(/^platform\.[0-9a-f]{16}\.file\.enc$/)])
    expect(await storedEnv(a, 'platform', WEB.path, monoVault)).toBe('WEB=1\n')
    const { key, vaultId } = await a.open()
    expect(
      (await a.sync.listRepos(key, vaultId)).rows.find((r) => r.path === WEB.path)
    ).toMatchObject({
      status: 'in-sync',
      storedName: entries()[0]
    })

    // B has the folder but no .env in it yet, and the repo has nothing else.
    const b = await on('b')
    expect(await rows(b, true)).toEqual({ 'platform/apps/web/.env': 'vault-newer' })
    expect(await pullRepo(b, 'platform', WEB.path)).toBeNull()
    expect(readFileSync(join(dirB, WEB.path), 'utf8')).toBe('WEB=1\n')
    expect((await rows(b))['platform/apps/web/.env']).toBe('in-sync')
  })

  it('never pulls into a folder this copy of the repo lacks, and never creates one', async () => {
    await pushRepo(await on('a'), 'platform', false, API.path)
    const b = await on('b')
    expect((await rows(b))['platform/apps/api/.env']).toBe('vault-only')
    const { key, vaultId } = await b.open()
    expect(await errorCode(b.sync.previewPull(key, vaultId, API))).toBe('ENV_FOLDER_MISSING')
    const expected = { localHash: null, vaultHash: null }
    expect(await errorCode(b.sync.pull(key, vaultId, { ...API, expected }))).toBe(
      'ENV_FOLDER_MISSING'
    )
    expect(await b.sync.autoPull(key, vaultId, API)).toBeNull()
    expect(existsSync(join(dirB, 'apps', 'api'))).toBe(false)
  })

  it('pulls each file of a repo on its own, backing it up in its own folder', async () => {
    const a = await on('a')
    write(dirA, WEB.path, 'WEB=2\n')
    await pushRepo(a, 'platform', false, WEB.path)
    write(dirA, API.path, 'API=2\n')
    await pushRepo(a, 'platform', false, API.path)
    mkdirSync(join(dirB, 'apps', 'api'))

    const b = await on('b')
    const { key, vaultId } = await b.open()
    // Every file of the repo, never just the first.
    const { rows: listed } = await b.sync.listRepos(key, vaultId, { only: 'platform' })
    expect(listed.map((r) => [r.path, r.status])).toEqual([
      [API.path, 'vault-newer'],
      [WEB.path, 'vault-newer']
    ])
    await b.config.updateConfig({ autoPull: true })
    b.session.unlock(key, vaultId, 5)
    try {
      const pulled = await b.autopull.runAutoPull()
      expect(pulled.map((r) => [r.name, r.path, r.status]).sort()).toEqual([
        ['platform', API.path, 'in-sync'],
        ['platform', WEB.path, 'in-sync']
      ])
    } finally {
      b.session.lock()
      await b.config.updateConfig({ autoPull: false })
    }
    expect(readFileSync(join(dirB, API.path), 'utf8')).toBe('API=2\n')
    expect(readFileSync(join(dirB, WEB.path), 'utf8')).toBe('WEB=2\n')
    // Only the web .env existed, and its backup is next to it.
    expect(backupsIn(join(dirB, 'apps', 'web'))).toHaveLength(1)
    expect(backupsIn(join(dirB, 'apps', 'api'))).toEqual([])
    expect(backupsIn(dirB)).toEqual([])
  })

  it('runs the git checks in the folder of the .env', async () => {
    const a = await on('a')
    for (const path of ['tools/open/.env', 'tools/tracked/.env', 'apps/docs/.env']) {
      await pushRepo(a, 'platform', false, path)
    }
    const { key, vaultId } = await a.open()
    const preview = (path: string): Promise<PullPreview> =>
      a.sync.previewPull(key, vaultId, envFile('platform', path))
    expect(await preview(WEB.path)).toMatchObject({
      ignored: true,
      backupIgnored: true,
      tracked: false
    })
    expect(await preview('apps/docs/.env')).toMatchObject({ ignored: true, backupIgnored: false })
    expect(await preview('tools/open/.env')).toMatchObject({ ignored: false, tracked: false })
    expect(await preview('tools/tracked/.env')).toMatchObject({ tracked: true })

    const tracked = envFile('platform', 'tools/tracked/.env')
    const trackedPreview = await preview(tracked.path)
    expect(
      await a.sync
        .pull(key, vaultId, { ...tracked, expected: trackedPreview.expected })
        .catch((err: unknown) => err)
    ).toMatchObject({
      code: 'ENV_TRACKED',
      message: expect.stringContaining('git rm --cached tools/tracked/.env')
    })
    const open = envFile('platform', 'tools/open/.env')
    const openPreview = await preview(open.path)
    expect(
      await errorCode(a.sync.pull(key, vaultId, { ...open, expected: openPreview.expected }))
    ).toBe('ENV_NOT_IGNORED')
  })

  it('adds the ignore lines to the root .gitignore for an .env in a folder', async () => {
    const svc = makeRepo(mpA, 'svc', {})
    write(svc, 'api/.env', 'S=1\n')
    const a = await on('a')
    expect((await rows(a, true))['svc/api/.env']).toBe('local-only')
    await pushRepo(a, 'svc', false, 'api/.env')
    const { key } = await a.open()
    expect(await a.sync.addGitignore(key, envFile('svc', 'api/.env'))).toEqual({
      ignored: true,
      backupIgnored: true,
      tracked: false
    })
    expect(readFileSync(join(svc, '.gitignore'), 'utf8')).toBe('.env\n.env.bak.*\n')
    expect(existsSync(join(svc, 'api', '.gitignore'))).toBe(false)
  })

  it('edits the vault copy of an .env in a folder, which must be in this copy of the repo', async () => {
    const a = await on('a')
    const { key, vaultId } = await a.open()
    const opened = await a.sync.openEditor(key, WEB)
    expect(opened.entries.map((e) => e.key)).toEqual(['WEB'])
    await a.sync.saveEdit(key, vaultId, {
      ...WEB,
      expectedVaultHash: opened.expectedVaultHash,
      set: [{ key: 'WEB', value: '3' }],
      add: [],
      remove: [],
      mark: []
    })
    expect(await storedEnv(a, 'platform', WEB.path, monoVault)).toBe('WEB=3\n')
    expect((await rows(a))['platform/apps/web/.env']).toBe('vault-newer')

    const b = await on('b')
    const docs = envFile('platform', 'apps/docs/.env')
    expect(await errorCode(b.sync.openEditor((await b.open()).key, docs))).toBe(
      'ENV_FOLDER_MISSING'
    )
  })

  it('lists a file entry that fails verification as its own row, and the others as usual', async () => {
    const a = await on('a')
    const { key, vaultId } = await a.open()
    const docs = (await a.sync.listRepos(key, vaultId)).rows.find(
      (r) => r.path === 'apps/docs/.env'
    )
    const file = join(monoVault, docs?.storedName ?? 'missing')
    const bytes = readFileSync(file)
    try {
      const bad = Buffer.from(bytes)
      bad[bad.length - 1] = (bad[bad.length - 1] ?? 0) ^ 1
      writeFileSync(file, bad)
      const { rows: listed } = await a.sync.listRepos(key, vaultId)
      expect(listed.filter((r) => r.path === null)).toEqual([
        expect.objectContaining({
          name: 'platform',
          storedName: docs?.storedName,
          status: 'error',
          error: expect.objectContaining({ code: 'VAULT_TAMPERED' })
        })
      ])
      expect(listed.find((r) => r.path === WEB.path)?.status).toBe('vault-newer')
    } finally {
      writeFileSync(file, bytes)
    }
  })

  it('removes a vault copy, leaving every local file, and a later push continues its versions', async () => {
    const a = await on('a')
    const { key, vaultId } = await a.open()
    const api = (await a.sync.listRepos(key, vaultId)).rows.find((r) => r.path === API.path)
    expect(api).toMatchObject({ status: 'in-sync', vault: { version: 2 } })
    const wrong = { vaultName: API.repoName, path: API.path, expectedVaultHash: 'a'.repeat(64) }
    expect(await errorCode(a.sync.removeFromVault(key, vaultId, wrong))).toBe('VAULT_CHANGED')
    const before = entries()
    await a.sync.removeFromVault(key, vaultId, {
      ...wrong,
      expectedVaultHash: api?.vault?.contentHash ?? ''
    })
    expect(entries()).toEqual(before.filter((name) => name !== api?.storedName))
    expect(readFileSync(join(dirA, API.path), 'utf8')).toBe('API=2\n')
    expect((await rows(a, true))['platform/apps/api/.env']).toBe('local-only')
    const b = await on('b')
    expect((await rows(b, true))['platform/apps/api/.env']).toBe('local-only')
    expect(readFileSync(join(dirB, API.path), 'utf8')).toBe('API=2\n')

    write(dirA, API.path, 'API=3\n')
    await pushRepo(a, 'platform', false, API.path)
    const again = (await a.sync.listRepos(key, vaultId)).rows.find((r) => r.path === API.path)
    expect(again?.vault?.version).toBe(3)
    // Not a rollback on B, which had synced version 2.
    expect((await rows(b))['platform/apps/api/.env']).toBe('vault-newer')
  })

  it.skipIf(process.platform === 'win32')(
    'refuses an .env behind a symlinked folder, and skips a symlinked .env',
    async () => {
      mkdirSync(join(dirA, 'apps', 'shared'))
      symlinkSync('../../.env', join(dirA, 'apps', 'shared', '.env'))
      write(dirB, 'apps/linked/.env', 'L=1\n')
      await pushRepo(await on('b'), 'platform', false, 'apps/linked/.env')
      symlinkSync(join(dirA, 'apps', 'web'), join(dirA, 'apps', 'linked'))

      const a = await on('a')
      const listed = await rows(a, true)
      expect(listed['platform/apps/shared/.env']).toBeUndefined()
      expect(listed['platform/apps/linked/.env']).toBe('error:ENV_SYMLINK')
      const { key, vaultId } = await a.open()
      const linked = envFile('platform', 'apps/linked/.env')
      expect(await errorCode(a.sync.previewPull(key, vaultId, linked))).toBe('ENV_SYMLINK')
    }
  )

  it('falls back to the root .env and the vault copies for a repo git refuses', async () => {
    const broken = join(mpA, 'broken')
    write(broken, 'sub/.env', 'S=1\n')
    writeFileSync(join(broken, '.env'), 'B=1\n')
    writeFileSync(join(broken, '.git'), 'gitdir: ./nowhere\n')
    const a = await on('a')
    const listed = await rows(a, true)
    expect(listed['broken']).toBe('local-only')
    expect(listed['broken/sub/.env']).toBeUndefined()
    expect(listed['platform/apps/web/.env']).toBe('vault-newer')
  })

  it('keeps the root .env in its own entry, without a path', async () => {
    const a = await on('a')
    await pushRepo(a, 'platform')
    expect(entries()).toContain('platform.env.enc')
    expect((await rows(a))['platform']).toBe('in-sync')
    const { key } = await a.open()
    const payload = await decryptPayload(
      key,
      'platform',
      readFileSync(join(monoVault, 'platform.env.enc'))
    )
    expect(Object.keys(payload).sort()).toEqual([
      'contentHash',
      'envBase64',
      'updatedAt',
      'updatedBy',
      'version'
    ])
    expect(decodeEnv(payload).toString('utf8')).toBe('ROOT=1\n')
  })
})

describe('repo settings', { timeout: 30_000 }, () => {
  let settingsVault: string
  let location: VaultLocation
  let spA: string
  let spB: string
  const on = (name: 'a' | 'b'): Promise<Machine> =>
    machine(name, { projects: name === 'a' ? spA : spB, vault: location })
  const repoA = (name: string): string => join(spA, name)
  const repoB = (name: string): string => join(spB, name)
  const list = async (m: Machine, find = false): Promise<RepoList> => {
    const { key, vaultId } = await m.open()
    return m.sync.listRepos(key, vaultId, { find })
  }
  const info = async (m: Machine, name: string): Promise<RepoInfo | undefined> =>
    (await list(m)).repos.find((r) => r.name === name && r.local)
  const save = async (m: Machine, vaultName: string, rules: Partial<RepoRules>): Promise<void> => {
    const { key } = await m.open()
    await m.sync.saveRepoSettings(key, {
      vaultName,
      ignored: false,
      include: null,
      exclude: null,
      ...rules
    })
  }

  beforeAll(async () => {
    settingsVault = join(root, 'settings-vault')
    mkdirSync(settingsVault)
    location = { kind: 'folder', path: settingsVault }
    spA = join(root, 'settings-a')
    spB = join(root, 'settings-b')
    // The Next.js layout: a committed .env of defaults, the secrets in .env.local.
    const next = makeRepo(spA, 'next', {
      '.gitignore': '.env.local\n.env.bak.*\n',
      '.env': 'PUBLIC=1\n',
      '.env.local': 'SECRET=1\n',
      '.env.development': 'DEV=1\n',
      '.env.example': 'PUBLIC=\nSECRET=\n',
      '.env.test': 'T=1\n'
    })
    git(next, 'add', '.env', '.env.development')
    makeRepo(spA, 'pair', {
      '.gitignore': '.env\n.env.local\n.env.bak.*\n',
      '.env': 'P=1\n',
      '.env.local': 'PL=1\n'
    })
    makeRepo(spA, 'bare', { '.env.local': 'BL=1\n' })
    makeRepo(spA, 'empty', {})
    makeRepo(spA, 'def', {
      '.gitignore': '.env\n.env.staging\n.env.bak.*\n',
      '.env': 'D=1\n',
      '.env.staging': 'S=1\n'
    })
    makeRepo(spA, 'app', { '.gitignore': '.env\n.env.bak.*\n', '.env': 'APP=1\n' })
    makeRepo(spA, 'app-wt', { '.gitignore': '.env\n.env.bak.*\n' })
    makeRepo(spA, 'xx', { '.gitignore': '.env\n.env.bak.*\n', '.env': 'X=1\n' })
    const nextB = makeRepo(spB, 'next', {
      '.gitignore': '.env.local\n.env.bak.*\n',
      '.env': 'PUBLIC=1\n'
    })
    git(nextB, 'add', '.env')
    makeRepo(spB, 'pair', { '.gitignore': '.env\n.env.local\n.env.bak.*\n' })
    await (await on('a')).vault.vaultFor(location).create(PASSWORD)
  })

  it('syncs every .env until told otherwise, and finds variants but no templates or committed ones', async () => {
    const a = await on('a')
    expect(await rows(a, true)).toEqual({
      next: 'local-only',
      pair: 'local-only',
      bare: 'no-env',
      empty: 'no-env',
      def: 'local-only',
      app: 'local-only',
      'app-wt': 'no-env',
      xx: 'local-only'
    })
    const listed = await list(a)
    // .env.development is committed and .env.example a template: never listed.
    expect(listed.repos.find((r) => r.name === 'next')?.found).toEqual([
      '.env',
      '.env.local',
      '.env.test'
    ])
    expect(listed.settings).toEqual({
      defaults: { include: ['.env'], exclude: [] },
      repos: {},
      error: null
    })
    expect(readdirSync(settingsVault)).not.toContain('settings.enc')
  })

  it('syncs a variant on every machine once its repo includes it', async () => {
    const a = await on('a')
    expect((await rows(a, true))['next/.env.local']).toBeUndefined()
    await save(a, 'next', { include: ['.env', '.env.local'] })
    // No rescan needed: what git found is kept whatever the rules.
    expect(await rows(a)).toMatchObject({ next: 'local-only', 'next/.env.local': 'local-only' })
    await pushRepo(a, 'next', false, '.env.local')
    await pushRepo(a, 'next')

    // B has no settings of its own: they are in the vault.
    const b = await on('b')
    const listed = await list(b, true)
    expect(listed.settings.repos).toEqual({
      next: { ignored: false, include: ['.env', '.env.local'], exclude: null }
    })
    expect(await rows(b)).toMatchObject({ next: 'in-sync', 'next/.env.local': 'vault-newer' })
    await pullRepo(b, 'next', '.env.local')
    expect(readFileSync(join(repoB('next'), '.env.local'), 'utf8')).toBe('SECRET=1\n')
  })

  it('lists a vault copy its rules exclude, refuses to sync it, and removes it', async () => {
    const a = await on('a')
    // The committed .env holds defaults: sync only .env.local.
    await save(a, 'next', { include: ['.env.local'] })
    expect(await rows(a, true)).toEqual(
      expect.objectContaining({ next: 'excluded', 'next/.env.local': 'in-sync' })
    )
    const { key, vaultId } = await a.open()
    const rootEnv = envFile('next')
    // One at a time: a call started before its turn could reject unhandled.
    for (const attempt of [
      () => a.sync.previewPush(key, vaultId, rootEnv),
      () => a.sync.previewPull(key, vaultId, rootEnv),
      () => a.sync.openEditor(key, rootEnv),
      () => a.sync.addGitignore(key, rootEnv)
    ]) {
      expect(await errorCode(attempt())).toBe('ENV_EXCLUDED')
    }
    const excluded = (await list(a)).rows.find((r) => r.name === 'next' && r.path === '.env')
    expect(excluded).toMatchObject({ status: 'excluded', hasEnv: false, vault: { version: 1 } })
    await a.sync.removeFromVault(key, vaultId, {
      vaultName: 'next',
      path: '.env',
      expectedVaultHash: excluded?.vault?.contentHash ?? ''
    })
    const after = await rows(a)
    expect(after['next']).toBeUndefined()
    expect(after['next/.env.local']).toBe('in-sync')
  })

  it('backs up each env file apart, and adds its own name to .gitignore', async () => {
    const a = await on('a')
    await save(a, 'pair', { include: ['.env', '.env.local'] })
    await pushRepo(a, 'pair')
    await pushRepo(a, 'pair', false, '.env.local')
    const b = await on('b')
    await b.config.updateConfig({ backupCount: 1 })
    await pullRepo(b, 'pair')
    await pullRepo(b, 'pair', '.env.local')
    for (const round of [2, 3]) {
      const a2 = await on('a')
      writeFileSync(join(repoA('pair'), '.env'), `P=${round}\n`)
      writeFileSync(join(repoA('pair'), '.env.local'), `PL=${round}\n`)
      await pushRepo(a2, 'pair')
      await pushRepo(a2, 'pair', false, '.env.local')
      const b2 = await on('b')
      await pullRepo(b2, 'pair')
      await pullRepo(b2, 'pair', '.env.local')
    }
    const names = readdirSync(repoB('pair')).filter((n) => n.startsWith('.env.bak.'))
    expect(names.filter((n) => n.startsWith('.env.bak.local.'))).toHaveLength(1)
    expect(names.filter((n) => !n.startsWith('.env.bak.local.'))).toHaveLength(1)
    expect(readFileSync(join(repoB('pair'), '.env.local'), 'utf8')).toBe('PL=3\n')
    await (await on('b')).config.updateConfig({ backupCount: 3 })

    const a3 = await on('a')
    await save(a3, 'bare', { include: ['.env.local'] })
    const { key } = await a3.open()
    expect(await a3.sync.addGitignore(key, envFile('bare', '.env.local'))).toEqual({
      ignored: true,
      backupIgnored: true,
      tracked: false
    })
    expect(readFileSync(join(repoA('bare'), '.gitignore'), 'utf8')).toBe('.env.local\n.env.bak.*\n')
  })

  it('leaves an ignored repo alone on every machine, until it is no longer ignored', async () => {
    const a = await on('a')
    writeFileSync(join(repoA('pair'), '.env'), 'P=4\n')
    await pushRepo(a, 'pair')
    const pair = { include: ['.env', '.env.local'] }
    await save(a, 'pair', { ...pair, ignored: true })
    const listed = await list(a)
    expect(listed.rows.filter((r) => r.name === 'pair')).toEqual([])
    expect(listed.repos.find((r) => r.name === 'pair')).toMatchObject({
      ignored: true,
      copies: 2,
      vaultName: 'pair'
    })
    const { key, vaultId } = await a.open()
    expect(await errorCode(a.sync.previewPush(key, vaultId, envFile('pair')))).toBe('REPO_IGNORED')
    const remove = { vaultName: 'pair', path: '.env', expectedVaultHash: 'a'.repeat(64) }
    expect(await errorCode(a.sync.removeFromVault(key, vaultId, remove))).toBe('REPO_IGNORED')

    // B has a vault-newer .env there, which automatic pull leaves alone.
    const b = await on('b')
    const opened = await b.open()
    b.session.unlock(opened.key, opened.vaultId, null)
    await b.config.updateConfig({ autoPull: true })
    expect((await info(b, 'pair'))?.ignored).toBe(true)
    expect(await b.autopull.runAutoPull()).toEqual([])
    expect(readFileSync(join(repoB('pair'), '.env'), 'utf8')).toBe('P=3\n')

    await save(b, 'pair', pair)
    expect((await b.autopull.runAutoPull()).map((r) => `${r.name}/${r.path}`)).toEqual([
      'pair/.env'
    ])
    expect(readFileSync(join(repoB('pair'), '.env'), 'utf8')).toBe('P=4\n')
    b.session.lock({ notify: false })
    await b.config.updateConfig({ autoPull: false })
  })

  it('applies the defaults to repos without their own lists', async () => {
    const a = await on('a')
    const { key } = await a.open()
    await a.sync.saveDefaults(key, { include: ['.env', '.env.*'], exclude: [] })
    const listed = await rows(a, true)
    expect(listed['def/.env.staging']).toBe('local-only')
    // next has its own list.
    expect(listed['next/.env.test']).toBeUndefined()
    expect((await list(a)).settings.defaults).toEqual({ include: ['.env', '.env.*'], exclude: [] })
    await a.sync.saveDefaults(key, { include: ['.env'], exclude: [] })
    expect((await rows(a))['def/.env.staging']).toBeUndefined()
  })

  it("keeps another machine's change saved in between", async () => {
    const a = await on('a')
    const { storeFor } = await import('../src/main/store')
    const store = storeFor(location)
    const original = store.write.bind(store)
    const { key } = await a.open()
    let sneaked = false
    const spy = vi.spyOn(store, 'write').mockImplementation(async (name, bytes, expected) => {
      if (name === 'settings.enc' && !sneaked) {
        sneaked = true
        // Another machine saves another repo's settings just before this write.
        const v = a.vault.vaultFor(location)
        await a.vault.withEntryKeys(key, async (keys) => {
          const { settings } = await (await v.snapshot()).settings(keys)
          const other = { ignored: false, include: ['.env.other'], exclude: null }
          await v.writeSettings(keys, withRepo(settings, 'xx', other), expected)
        })
      }
      return original(name, bytes, expected)
    })
    try {
      await save(a, 'empty', { include: ['.env.local'] })
    } finally {
      spy.mockRestore()
    }
    expect(sneaked).toBe(true)
    const { repos } = (await list(a)).settings
    expect(repos['xx']?.include).toEqual(['.env.other'])
    expect(repos['empty']?.include).toEqual(['.env.local'])
    await save(a, 'xx', {})
  })

  it('lists a repo with no env files, even one whose rules leave out .env', async () => {
    const a = await on('a')
    const listed = await list(a)
    // empty includes only .env.local (the test above), so not even a placeholder row.
    expect(listed.rows.filter((r) => r.name === 'empty')).toEqual([])
    expect(listed.repos.find((r) => r.name === 'empty')).toMatchObject({
      local: true,
      ignored: false,
      copies: 0
    })
    await save(a, 'empty', {})
    expect((await rows(a))['empty']).toBe('no-env')
  })

  it('syncs a folder as another repo, keeping its own last sync', async () => {
    const a = await on('a')
    await pushRepo(a, 'app')
    await a.sync.setVaultName({ repoName: 'app-wt', vaultName: 'app' })
    expect((await a.config.getConfig()).repoNames).toEqual({ 'app-wt': 'app' })
    const wt = (await list(a)).rows.find((r) => r.name === 'app-wt')
    expect(wt).toMatchObject({ vaultName: 'app', local: true, status: 'vault-newer' })
    await pullRepo(a, 'app-wt')
    expect(readFileSync(join(repoA('app-wt'), '.env'), 'utf8')).toBe('APP=1\n')

    writeFileSync(join(repoA('app'), '.env'), 'APP=2\n')
    await pushRepo(a, 'app')
    expect(await rows(a)).toMatchObject({ app: 'in-sync', 'app-wt': 'vault-newer' })
    await pullRepo(a, 'app-wt')
    expect(await rows(a)).toMatchObject({ app: 'in-sync', 'app-wt': 'in-sync' })

    // Removing it sets the floor for both folders: a push from either goes on at v3.
    const { key, vaultId } = await a.open()
    const row = (await list(a)).rows.find((r) => r.name === 'app')
    await a.sync.removeFromVault(key, vaultId, {
      vaultName: 'app',
      path: '.env',
      expectedVaultHash: row?.vault?.contentHash ?? ''
    })
    expect(await rows(a)).toMatchObject({ app: 'local-only', 'app-wt': 'local-only' })
    await pushRepo(a, 'app-wt')
    expect((await list(a)).rows.find((r) => r.name === 'app')?.vault?.version).toBe(3)
  })

  it('keeps a folder and a repo of the same name only in the vault apart', async () => {
    const a = await on('a')
    await pushRepo(a, 'xx')
    await a.sync.setVaultName({ repoName: 'xx', vaultName: 'yy' })
    const listed = await list(a)
    const named = listed.rows.filter((r) => r.name === 'xx')
    expect(named).toEqual([
      expect.objectContaining({ local: true, vaultName: 'yy', status: 'local-only' }),
      expect.objectContaining({ local: false, vaultName: 'xx', status: 'vault-only' })
    ])
    expect(listed.repos.filter((r) => r.name === 'xx').map((r) => r.local)).toEqual([true, false])
    // Its own name again: no longer synced as another.
    await a.sync.setVaultName({ repoName: 'xx', vaultName: 'XX' })
    await a.sync.setVaultName({ repoName: 'app-wt', vaultName: 'app-wt' })
    expect((await a.config.getConfig()).repoNames).toEqual({})
    expect(await errorCode(a.sync.setVaultName({ repoName: 'nope', vaultName: 'x' }))).toBe(
      'REPO_NOT_FOUND'
    )
  })

  it("picks the env file the command means among a folder's", async () => {
    const cl = makeRepo(spA, 'cl', { '.gitignore': '.env*\n', '.env.local': 'L=1\n' })
    mkdirSync(join(cl, 'one', 'src'), { recursive: true })
    writeFileSync(join(cl, 'one', '.env'), 'O=1\n')
    writeFileSync(join(cl, 'one', '.env.local'), 'OL=1\n')
    mkdirSync(join(cl, 'two'))
    writeFileSync(join(cl, 'two', '.env.local'), 'TL=1\n')
    writeFileSync(join(cl, 'two', '.env.test'), 'TT=1\n')
    // A template is never picked, even as the only file there.
    mkdirSync(join(cl, 'tpl'))
    writeFileSync(join(cl, 'tpl', '.env.example'), 'X=\n')
    const a = await on('a')
    await save(a, 'cl', { include: ['.env', '.env.*'] })
    const { key, vaultId } = await a.open()
    a.session.unlock(key, vaultId, 5)
    const cli = a.clicommands.cliCommands(() => undefined)
    try {
      const at = async (...folders: string[]): Promise<string> =>
        (await cli.previewPush.run({ dir: join(cl, ...folders) })).path
      // The root has only .env.local; one has .env and .env.local.
      expect(await at()).toBe('.env.local')
      expect(await at('one', 'src')).toBe('one/.env')
      expect(await at('tpl')).toBe('.env.local')
      expect(await errorCode(at('two'))).toBe('ENV_AMBIGUOUS')
      const picked = await cli.previewPush.run({ dir: join(cl, 'two'), path: 'two/.env.test' })
      expect(picked).toMatchObject({ repo: 'cl', path: 'two/.env.test' })
      // Only what the repo syncs: with .env.test excluded, two has one file.
      await save(a, 'cl', { include: ['.env', '.env.*'], exclude: ['.env.test'] })
      expect(await at('two')).toBe('two/.env.local')

      await save(a, 'cl', { ignored: true })
      expect(await errorCode(at())).toBe('REPO_IGNORED')
      expect(await errorCode(cli.status.run({ repo: 'cl' }))).toBe('REPO_IGNORED')
      expect((await cli.status.run({ all: true })).ignored).toEqual(['cl'])
    } finally {
      a.session.lock({ notify: false })
    }
    await save(a, 'cl', {})
  })

  it('falls back to the built-in rules when the settings are tampered with, until reset', async () => {
    const a = await on('a')
    writeFileSync(join(settingsVault, 'settings.enc'), Buffer.from('not encrypted at all'))
    const listed = await list(a, true)
    expect(listed.settings.error?.code).toBe('VAULT_TAMPERED')
    expect(listed.settings.defaults).toEqual({ include: ['.env'], exclude: [] })
    // next's .env.local is no longer included, so its vault copy is listed as excluded.
    const local = listed.rows.find((r) => r.name === 'next' && r.path === '.env.local')
    expect(local?.status).toBe('excluded')
    expect(await errorCode(save(a, 'next', { include: ['.env.local'] }))).toBe('VAULT_TAMPERED')
    const { key } = await a.open()
    await a.sync.resetSettings(key)
    expect((await list(a)).settings).toEqual({
      defaults: { include: ['.env'], exclude: [] },
      repos: {},
      error: null
    })
    await save(a, 'next', { include: ['.env.local'] })
  })
})

describe('resolving a conflict', { timeout: 30_000 }, () => {
  const IGNORE = '.env\n.env.bak.*\n'
  let mergeVault: string
  let location: VaultLocation
  let mpA: string
  let mpB: string
  const on = (name: 'a' | 'b'): Promise<Machine> =>
    machine(name, { projects: name === 'a' ? mpA : mpB, vault: location })
  const envOf = (projects: string, repo: string): string => join(projects, repo, '.env')
  const stored = (m: Machine, repo: string): Promise<string> =>
    storedEnv(m, repo, '.env', mergeVault)

  beforeAll(async () => {
    mergeVault = join(root, 'merge-vault')
    mkdirSync(mergeVault)
    location = { kind: 'folder', path: mergeVault }
    mpA = join(root, 'merge-a')
    mpB = join(root, 'merge-b')
    await (await on('a')).vault.vaultFor(location).create(PASSWORD)
  })

  it('keeps both machines’ changes, chosen key by key, and ends in sync on both', async () => {
    makeRepo(mpA, 'mix', { '.gitignore': IGNORE, '.env': 'SAME=1\nA=1\nB=1\nDROP=x\n' })
    makeRepo(mpB, 'mix', { '.gitignore': IGNORE })
    await pushRepo(await on('a'), 'mix')
    await pullRepo(await on('b'), 'mix')

    // A changes A and adds NEWA; B changes B and removes DROP.
    writeFileSync(envOf(mpA, 'mix'), 'SAME=1\nA=2\nB=1\nDROP=x\nNEWA=a\n')
    await pushRepo(await on('a'), 'mix')
    writeFileSync(envOf(mpB, 'mix'), '# mine\nSAME=1\nA=1\nB=2\n')

    const b = await on('b')
    expect((await rows(b))['mix']).toBe('conflict')
    const { key, vaultId } = await b.open()
    const preview = await b.sync.previewMerge(key, vaultId, envFile('mix'))
    expect(preview).toMatchObject({
      keys: [
        { key: 'A', kind: 'differs' },
        { key: 'B', kind: 'differs' },
        { key: 'DROP', kind: 'vault-only' },
        { key: 'NEWA', kind: 'vault-only' }
      ],
      unchanged: 1,
      kept: [],
      unset: [],
      formatOnly: false,
      neverSynced: false,
      rollback: false,
      ignored: true,
      backupIgnored: true,
      tracked: false,
      vault: { version: 2 }
    })

    const req = { ...envFile('mix'), expected: preview.expected }
    expect((await b.sync.mergeValues(key, req)).values).toEqual([
      { key: 'A', local: '1', vault: '2' },
      { key: 'B', local: '2', vault: '1' },
      { key: 'DROP', local: null, vault: 'x' },
      { key: 'NEWA', local: null, vault: 'a' }
    ])

    const result = await b.sync.merge(key, vaultId, {
      ...req,
      choices: [
        { key: 'A', take: 'vault' },
        { key: 'B', take: 'local' },
        { key: 'DROP', take: 'local' },
        { key: 'NEWA', take: 'vault' }
      ]
    })
    expect(result.row).toMatchObject({ status: 'in-sync', vault: { version: 3 } })
    // The vault's layout; B's comment goes, as on a pull.
    const merged = 'SAME=1\nA=2\nB=2\nNEWA=a\n'
    expect(readFileSync(envOf(mpB, 'mix'), 'utf8')).toBe(merged)
    expect(await stored(b, 'mix')).toBe(merged)
    expect(readFileSync(join(mpB, 'mix', result.backupName as string), 'utf8')).toBe(
      '# mine\nSAME=1\nA=1\nB=2\n'
    )
    expect((await rows(b))['mix']).toBe('in-sync')

    const a = await on('a')
    expect((await rows(a))['mix']).toBe('vault-newer')
    await pullRepo(a, 'mix')
    expect(readFileSync(envOf(mpA, 'mix'), 'utf8')).toBe(merged)
    expect((await rows(a))['mix']).toBe('in-sync')
  })

  it("keeps this machine's file as written when it wins every key", async () => {
    makeRepo(mpA, 'mine', { '.gitignore': IGNORE, '.env': 'A=1\nB=1\nOLD=o\n' })
    makeRepo(mpB, 'mine', { '.gitignore': IGNORE })
    await pushRepo(await on('a'), 'mine')
    await pullRepo(await on('b'), 'mine')
    writeFileSync(envOf(mpA, 'mine'), '# from a\nA=2\nB=1\nOLD=o\n')
    await pushRepo(await on('a'), 'mine')
    const mine = '# mine\nB=3\nA=1\n\n# new\nNEW=n\n'
    writeFileSync(envOf(mpB, 'mine'), mine)

    const b = await on('b')
    const { key, vaultId } = await b.open()
    const preview = await b.sync.previewMerge(key, vaultId, envFile('mine'))
    const result = await b.sync.merge(key, vaultId, {
      ...envFile('mine'),
      expected: preview.expected,
      choices: preview.keys.map((k) => ({ key: k.key, take: 'local' as const }))
    })
    // Untouched (no backup), and the vault copy is the file as written.
    expect(result.backupName).toBeNull()
    expect(readFileSync(envOf(mpB, 'mine'), 'utf8')).toBe(mine)
    expect(await stored(b, 'mine')).toBe(mine)
    expect((await rows(b))['mine']).toBe('in-sync')
  })

  it('refuses a stale review and incomplete choices, leaving both sides alone', async () => {
    makeRepo(mpA, 'stale', { '.gitignore': IGNORE, '.env': 'A=1\n' })
    makeRepo(mpB, 'stale', { '.gitignore': IGNORE, '.env': 'A=2\n' })
    await pushRepo(await on('a'), 'stale')
    const b = await on('b')
    const { key, vaultId } = await b.open()
    const preview = await b.sync.previewMerge(key, vaultId, envFile('stale'))
    expect(preview.neverSynced).toBe(true)
    const req = { ...envFile('stale'), expected: preview.expected }

    expect(await errorCode(b.sync.merge(key, vaultId, { ...req, choices: [] }))).toBe(
      'MERGE_INVALID'
    )
    expect(
      await errorCode(
        b.sync.merge(key, vaultId, {
          ...req,
          choices: [
            { key: 'A', take: 'local' },
            { key: 'OTHER', take: 'local' }
          ]
        })
      )
    ).toBe('MERGE_INVALID')

    writeFileSync(envOf(mpB, 'stale'), 'A=3\n')
    expect(await errorCode(b.sync.mergeValues(key, req))).toBe('LOCAL_CHANGED')
    expect(
      await errorCode(
        b.sync.merge(key, vaultId, { ...req, choices: [{ key: 'A', take: 'local' }] })
      )
    ).toBe('LOCAL_CHANGED')
    expect(await stored(b, 'stale')).toBe('A=1\n')
    expect(readFileSync(envOf(mpB, 'stale'), 'utf8')).toBe('A=3\n')
  })

  it('checks git before writing either side', async () => {
    makeRepo(mpA, 'open', { '.gitignore': IGNORE, '.env': 'A=1\n' })
    makeRepo(mpB, 'open', { '.env': 'A=2\n' })
    await pushRepo(await on('a'), 'open')
    const b = await on('b')
    const { key, vaultId } = await b.open()
    const preview = await b.sync.previewMerge(key, vaultId, envFile('open'))
    expect(preview).toMatchObject({ ignored: false, neverSynced: true })
    const req = { ...envFile('open'), expected: preview.expected }
    const choices = [{ key: 'A', take: 'local' as const }]
    expect(await errorCode(b.sync.merge(key, vaultId, { ...req, choices }))).toBe('ENV_NOT_IGNORED')
    // Nothing reached the vault.
    expect(await stored(b, 'open')).toBe('A=1\n')
  })

  it('keeps machine-specific values and lists them apart', async () => {
    makeRepo(mpA, 'kept', {
      '.gitignore': IGNORE,
      '.env': 'A=1\n# envvault:local\nDB=/a\n'
    })
    makeRepo(mpB, 'kept', { '.gitignore': IGNORE, '.env': 'A=2\nDB=/b\nNEW=n\n' })
    await pushRepo(await on('a'), 'kept')
    const b = await on('b')
    const { key, vaultId } = await b.open()
    const preview = await b.sync.previewMerge(key, vaultId, envFile('kept'))
    expect(preview.keys).toEqual([
      { key: 'A', kind: 'differs' },
      { key: 'NEW', kind: 'local-only' }
    ])
    expect(preview.kept).toEqual(['DB'])
    await b.sync.merge(key, vaultId, {
      ...envFile('kept'),
      expected: preview.expected,
      choices: [
        { key: 'A', take: 'local' },
        { key: 'NEW', take: 'local' }
      ]
    })
    expect(readFileSync(envOf(mpB, 'kept'), 'utf8')).toBe('A=2\n# envvault:local\nDB=/b\nNEW=n\n')
    expect(await stored(b, 'kept')).toBe('A=2\n# envvault:local\nDB=\nNEW=n\n')
    expect((await rows(b))['kept']).toBe('in-sync')
  })

  it('never merges a vault copy that went backwards', async () => {
    makeRepo(mpA, 'back', { '.gitignore': IGNORE, '.env': 'A=1\n' })
    makeRepo(mpB, 'back', { '.gitignore': IGNORE })
    await pushRepo(await on('a'), 'back')
    const entry = join(mergeVault, 'back.env.enc')
    const v1 = readFileSync(entry)
    writeFileSync(envOf(mpA, 'back'), 'A=2\n')
    await pushRepo(await on('a'), 'back')
    await pullRepo(await on('b'), 'back')
    writeFileSync(entry, v1)
    writeFileSync(envOf(mpB, 'back'), 'A=3\n')

    const b = await on('b')
    expect((await rows(b))['back']).toBe('conflict')
    const { key, vaultId } = await b.open()
    const preview = await b.sync.previewMerge(key, vaultId, envFile('back'))
    expect(preview.rollback).toBe(true)
    const req = { ...envFile('back'), expected: preview.expected }
    expect(
      await errorCode(
        b.sync.merge(key, vaultId, { ...req, choices: [{ key: 'A', take: 'local' }] })
      )
    ).toBe('MERGE_INVALID')
  })

  it('refuses a file with a key assigned twice', async () => {
    makeRepo(mpA, 'dup', { '.gitignore': IGNORE, '.env': 'A=1\n' })
    makeRepo(mpB, 'dup', { '.gitignore': IGNORE, '.env': 'A=2\nA=3\n' })
    await pushRepo(await on('a'), 'dup')
    const b = await on('b')
    const { key, vaultId } = await b.open()
    expect(await errorCode(b.sync.previewMerge(key, vaultId, envFile('dup')))).toBe(
      'ENV_DUPLICATE_KEY'
    )
  })
})

describe('marking a key machine-specific', { timeout: 30_000 }, () => {
  const IGNORE = '.env\n.env.bak.*\n'
  const M = '# envvault:local'
  let markVault: string
  let location: VaultLocation
  let kpA: string
  let kpB: string
  const on = (name: 'a' | 'b'): Promise<Machine> =>
    machine(name, { projects: name === 'a' ? kpA : kpB, vault: location })
  const envOf = (projects: string, repo: string): string => join(projects, repo, '.env')
  const stored = (m: Machine, repo: string): Promise<string> =>
    storedEnv(m, repo, '.env', markVault)
  /** Resolve with `choices`, or nothing to choose. */
  const resolve = async (
    m: Machine,
    repo: string,
    choices: { key: string; take: 'local' | 'vault' | 'machine' }[] = []
  ): Promise<void> => {
    const { key, vaultId } = await m.open()
    const preview = await m.sync.previewMerge(key, vaultId, envFile(repo))
    await m.sync.merge(key, vaultId, { ...envFile(repo), expected: preview.expected, choices })
  }

  beforeAll(async () => {
    markVault = join(root, 'mark-vault')
    mkdirSync(markVault)
    location = { kind: 'folder', path: markVault }
    kpA = join(root, 'mark-a')
    kpB = join(root, 'mark-b')
    await (await on('a')).vault.vaultFor(location).create(PASSWORD)
  })

  it('marks a key from the editor; each machine then keeps its own value', async () => {
    makeRepo(kpA, 'ports', { '.gitignore': IGNORE, '.env': 'A=1\nPORT=3000\n' })
    makeRepo(kpB, 'ports', { '.gitignore': IGNORE })
    await pushRepo(await on('a'), 'ports')
    await pullRepo(await on('b'), 'ports')
    // B changes its port before it hears about the marker.
    writeFileSync(envOf(kpB, 'ports'), 'A=1\nPORT=4000\n')

    const a = await on('a')
    const { key, vaultId } = await a.open()
    const { expectedVaultHash } = await a.sync.openEditor(key, envFile('ports'))
    const saved = await a.sync.saveEdit(key, vaultId, {
      ...envFile('ports'),
      expectedVaultHash,
      set: [],
      add: [],
      remove: [],
      mark: ['PORT']
    })
    expect(saved.changed).toBe(true)
    expect(await stored(a, 'ports')).toBe(`A=1\n${M}\nPORT=\n`)
    expect((await a.sync.openEditor(key, envFile('ports'))).entries).toContainEqual({
      key: 'PORT',
      value: '',
      marked: true
    })

    // A pulls as usual: its value stays, now marked.
    expect((await rows(a))['ports']).toBe('vault-newer')
    await pullRepo(a, 'ports')
    expect(readFileSync(envOf(kpA, 'ports'), 'utf8')).toBe(`A=1\n${M}\nPORT=3000\n`)
    expect((await rows(a))['ports']).toBe('in-sync')

    // B changed PORT meanwhile: a conflict with nothing to choose, which marks B's value.
    const b = await on('b')
    expect((await rows(b))['ports']).toBe('conflict')
    const k = await b.open()
    const preview = await b.sync.previewMerge(k.key, k.vaultId, envFile('ports'))
    expect(preview).toMatchObject({
      keys: [],
      kept: ['PORT'],
      unmarked: ['PORT'],
      formatOnly: false
    })
    await resolve(b, 'ports')
    expect(readFileSync(envOf(kpB, 'ports'), 'utf8')).toBe(`A=1\n${M}\nPORT=4000\n`)
    expect(await stored(b, 'ports')).toBe(`A=1\n${M}\nPORT=\n`)
    expect((await rows(b))['ports']).toBe('in-sync')

    // From now on, a different port on either machine is no change at all.
    writeFileSync(envOf(kpB, 'ports'), `A=1\n${M}\nPORT=4001\n`)
    expect((await rows(b))['ports']).toBe('in-sync')
  })

  it('refuses to mark a key the editor finds already marked or gone', async () => {
    const a = await on('a')
    const { key, vaultId } = await a.open()
    const { expectedVaultHash } = await a.sync.openEditor(key, envFile('ports'))
    const edit = (mark: string[]): Promise<unknown> =>
      a.sync.saveEdit(key, vaultId, {
        ...envFile('ports'),
        expectedVaultHash,
        set: [],
        add: [],
        remove: [],
        mark
      })
    expect(await errorCode(edit(['PORT']))).toBe('EDIT_INVALID')
    expect(await errorCode(edit(['NOPE']))).toBe('EDIT_INVALID')
  })

  it('resolves a conflict by making a key machine-specific', async () => {
    makeRepo(kpA, 'svc', { '.gitignore': IGNORE, '.env': 'A=1\nPORT=3000\n' })
    makeRepo(kpB, 'svc', { '.gitignore': IGNORE })
    await pushRepo(await on('a'), 'svc')
    await pullRepo(await on('b'), 'svc')
    writeFileSync(envOf(kpA, 'svc'), 'A=1\nPORT=3001\n')
    await pushRepo(await on('a'), 'svc')
    writeFileSync(envOf(kpB, 'svc'), 'A=1\nPORT=4000\nDEV=b\n')

    const b = await on('b')
    const { key, vaultId } = await b.open()
    const preview = await b.sync.previewMerge(key, vaultId, envFile('svc'))
    expect(preview.keys).toEqual([
      { key: 'PORT', kind: 'differs' },
      { key: 'DEV', kind: 'local-only' }
    ])
    await resolve(b, 'svc', [
      { key: 'PORT', take: 'machine' },
      { key: 'DEV', take: 'machine' }
    ])
    expect(readFileSync(envOf(kpB, 'svc'), 'utf8')).toBe(`A=1\n${M}\nPORT=4000\n${M}\nDEV=b\n`)
    expect(await stored(b, 'svc')).toBe(`A=1\n${M}\nPORT=\n${M}\nDEV=\n`)
    expect((await rows(b))['svc']).toBe('in-sync')

    // A keeps its own port and gets DEV empty.
    const a = await on('a')
    expect((await rows(a))['svc']).toBe('vault-newer')
    await pullRepo(a, 'svc')
    expect(readFileSync(envOf(kpA, 'svc'), 'utf8')).toBe(`A=1\n${M}\nPORT=3001\n${M}\nDEV=\n`)
    expect((await rows(a))['svc']).toBe('in-sync')
  })
})

describe('pull and mark', { timeout: 30_000 }, () => {
  const IGNORE = '.env\n.env.bak.*\n'
  const M = '# envvault:local'
  let pmVault: string
  let location: VaultLocation
  let pmA: string
  let pmB: string
  const on = (name: 'a' | 'b'): Promise<Machine> =>
    machine(name, { projects: name === 'a' ? pmA : pmB, vault: location })
  const envOf = (projects: string, repo: string): string => join(projects, repo, '.env')
  const stored = (m: Machine, repo: string): Promise<string> => storedEnv(m, repo, '.env', pmVault)

  beforeAll(async () => {
    pmVault = join(root, 'pm-vault')
    mkdirSync(pmVault)
    location = { kind: 'folder', path: pmVault }
    pmA = join(root, 'pm-a')
    pmB = join(root, 'pm-b')
    await (await on('a')).vault.vaultFor(location).create(PASSWORD)
  })

  it('pulls the rest and keeps the marked keys, writing both sides', async () => {
    makeRepo(pmA, 'web', { '.gitignore': IGNORE, '.env': 'A=1\nPORT=3000\n' })
    makeRepo(pmB, 'web', { '.gitignore': IGNORE })
    await pushRepo(await on('a'), 'web')
    await pullRepo(await on('b'), 'web')
    // B sets its own port and pushes it; A's would be overwritten by a plain pull.
    writeFileSync(envOf(pmB, 'web'), 'A=2\nPORT=4000\n')
    await pushRepo(await on('b'), 'web')

    const a = await on('a')
    expect((await rows(a))['web']).toBe('vault-newer')
    const { key, vaultId } = await a.open()
    const preview = await a.sync.previewPull(key, vaultId, envFile('web'))
    expect(preview.diff.changed).toEqual(['A', 'PORT'])
    const req = { ...envFile('web'), expected: preview.expected, mark: ['PORT'] }

    // The raw diff shows the pull with the mark.
    const raw = await a.sync.pullRawDiff(key, { ...req, values: true })
    expect(raw.lines.filter((l) => l.kind !== 'gap' && l.kind !== 'same')).toEqual([
      { kind: 'del', text: 'A=1', oldNo: 1, newNo: null },
      { kind: 'add', text: 'A=2', oldNo: null, newNo: 1 },
      { kind: 'add', text: M, oldNo: null, newNo: 2 }
    ])

    const result = await a.sync.pull(key, vaultId, req)
    expect(result.vault.version).toBe(3)
    expect(readFileSync(envOf(pmA, 'web'), 'utf8')).toBe(`A=2\n${M}\nPORT=3000\n`)
    expect(readFileSync(join(pmA, 'web', result.backupName as string), 'utf8')).toBe(
      'A=1\nPORT=3000\n'
    )
    expect(await stored(a, 'web')).toBe(`A=2\n${M}\nPORT=\n`)
    expect((await rows(a))['web']).toBe('in-sync')

    // B keeps its own port and gets the marker.
    const b = await on('b')
    expect((await rows(b))['web']).toBe('vault-newer')
    await pullRepo(b, 'web')
    expect(readFileSync(envOf(pmB, 'web'), 'utf8')).toBe(`A=2\n${M}\nPORT=4000\n`)
    expect((await rows(b))['web']).toBe('in-sync')
  })

  it('refuses to mark a key that does not change, and a rollback', async () => {
    makeRepo(pmA, 'api', { '.gitignore': IGNORE, '.env': 'A=1\nB=1\n' })
    makeRepo(pmB, 'api', { '.gitignore': IGNORE })
    await pushRepo(await on('a'), 'api')
    await pullRepo(await on('b'), 'api')
    writeFileSync(envOf(pmB, 'api'), 'A=2\nB=1\nNEW=n\n')
    await pushRepo(await on('b'), 'api')

    const a = await on('a')
    const { key, vaultId } = await a.open()
    const preview = await a.sync.previewPull(key, vaultId, envFile('api'))
    const pull = (mark: string[]): Promise<unknown> =>
      a.sync.pull(key, vaultId, { ...envFile('api'), expected: preview.expected, mark })
    for (const mark of [['B'], ['NEW'], ['MISSING']]) {
      expect(await errorCode(pull(mark)), mark[0]).toBe('MERGE_INVALID')
    }
    expect(readFileSync(envOf(pmA, 'api'), 'utf8')).toBe('A=1\nB=1\n')

    // v1 back in the vault on a machine that synced v2: never marked.
    const entry = join(pmVault, 'api.env.enc')
    const v2 = readFileSync(entry)
    await pullRepo(a, 'api')
    writeFileSync(envOf(pmA, 'api'), 'A=3\nB=1\nNEW=n\n')
    await pushRepo(await on('a'), 'api')
    const a2 = await on('a')
    writeFileSync(entry, v2)
    writeFileSync(envOf(pmA, 'api'), 'A=4\nB=1\nNEW=n\n')
    const k = await a2.open()
    const back = await a2.sync.previewPull(k.key, k.vaultId, envFile('api'))
    expect(back.rollback).toBe(true)
    expect(
      await errorCode(
        a2.sync.pull(k.key, k.vaultId, { ...envFile('api'), expected: back.expected, mark: ['A'] })
      )
    ).toBe('MERGE_INVALID')
  })
})
