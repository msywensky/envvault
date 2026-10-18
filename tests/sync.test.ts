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
import type { CliTable } from '../src/main/cliserver'
import type { RepoRow } from '../src/shared/types'

const h = vi.hoisted(() => ({ userData: '' }))

vi.mock('electron', () => ({ app: { getPath: () => h.userData } }))
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
async function machine(name: 'a' | 'b'): Promise<Machine> {
  h.userData = join(root, `userData-${name}`)
  vi.resetModules()
  const config = await import('../src/main/config')
  const vault = await import('../src/main/vault')
  const sync = await import('../src/main/sync')
  const session = await import('../src/main/session')
  const autopull = await import('../src/main/autopull')
  const clicommands = await import('../src/main/clicommands')
  await config.updateConfig({
    projectsPath: name === 'a' ? projA : projB,
    vault: { kind: 'folder', path: vaultDir }
  })
  const open = (): Promise<{ key: Uint8Array; vaultId: string }> =>
    vault.vaultAt(vaultDir).open(PASSWORD)
  return { config, vault, sync, session, autopull, clicommands, open }
}

async function rows(m: Machine): Promise<Record<string, string>> {
  const { key, vaultId } = await m.open()
  const list = await m.sync.listRepos(key, vaultId)
  return Object.fromEntries(
    list.map((r) => [r.name, r.status === 'error' ? `error:${r.error?.code}` : r.status])
  )
}

async function pushRepo(m: Machine, repo: string, overwriteConfirmed = false): Promise<void> {
  const { key, vaultId } = await m.open()
  const preview = await m.sync.previewPush(key, vaultId, repo)
  await m.sync.push(key, vaultId, {
    repoName: repo,
    overwriteConfirmed,
    expected: preview.expected
  })
}

async function pullRepo(m: Machine, repo: string): Promise<string | null> {
  const { key, vaultId } = await m.open()
  const preview = await m.sync.previewPull(key, vaultId, repo)
  return (await m.sync.pull(key, vaultId, { repoName: repo, expected: preview.expected }))
    .backupName
}

const errorCode = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p
  } catch (err) {
    return (err as { code?: string }).code ?? String(err)
  }
  return 'no error'
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
    const preview = await m.sync.previewPush(key, vaultId, 'app1')
    expect(preview.diff).toEqual({ added: ['A'], removed: [], changed: [], unchanged: 0 })
    expect(preview.needsOverwrite).toBe(false)
    writeFileSync(join(projA, 'app1', '.env'), 'A=1\nLATE=1\n')
    expect(
      await errorCode(
        m.sync.push(key, vaultId, {
          repoName: 'app1',
          overwriteConfirmed: false,
          expected: preview.expected
        })
      )
    ).toBe('LOCAL_CHANGED')
    writeFileSync(join(projA, 'app1', '.env'), 'A=1\n')
    await m.sync.push(key, vaultId, {
      repoName: 'app1',
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
    const list = await m.sync.listRepos(key, vaultId)
    expect(list.find((r) => r.name === 'app1')?.vault?.version).toBe(2)
  })

  it('blocks pulls into a repo whose .env is not ignored, until fixed', async () => {
    const m = await machine('a')
    await pushRepo(m, 'app3')
    const { key, vaultId } = await m.open()
    const preview = await m.sync.previewPull(key, vaultId, 'app3')
    expect(preview.ignored).toBe(false)
    expect(
      await errorCode(m.sync.pull(key, vaultId, { repoName: 'app3', expected: preview.expected }))
    ).toBe('ENV_NOT_IGNORED')
    expect(await m.sync.addGitignore('app3')).toEqual({
      ignored: true,
      backupIgnored: true,
      tracked: false
    })
    expect(readFileSync(join(projA, 'app3', '.gitignore'), 'utf8')).toBe('.env\n.env.bak.*\n')
    // Idempotent.
    await m.sync.addGitignore('app3')
    expect(readFileSync(join(projA, 'app3', '.gitignore'), 'utf8')).toBe('.env\n.env.bak.*\n')
  })

  it('reports un-ignored backups in the preview, and the same fix covers them', async () => {
    const m = await machine('a')
    const dir = makeRepo(projA, 'envonly', { '.gitignore': '.env\n', '.env': 'E=1\n' })
    await pushRepo(m, 'envonly')
    writeFileSync(join(dir, '.env'), 'E=2\n')
    const { key, vaultId } = await m.open()
    const preview = await m.sync.previewPull(key, vaultId, 'envonly')
    expect(preview).toMatchObject({ ignored: true, backupIgnored: false, tracked: false })
    expect(
      await errorCode(
        m.sync.pull(key, vaultId, { repoName: 'envonly', expected: preview.expected })
      )
    ).toBe('BACKUP_NOT_IGNORED')
    expect(await m.sync.addGitignore('envonly')).toMatchObject({ backupIgnored: true })
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe('.env\n.env.bak.*\n')
    rmSync(dir, { recursive: true, force: true })
    rmSync(join(vaultDir, 'envonly.env.enc'))
  })

  it('blocks pulls when .env is tracked by git', async () => {
    const m = await machine('a')
    await pushRepo(m, 'app2')
    git(join(projA, 'app2'), 'add', '-f', '.env')
    const { key, vaultId } = await m.open()
    const preview = await m.sync.previewPull(key, vaultId, 'app2')
    expect(preview.tracked).toBe(true)
    expect(
      await errorCode(m.sync.pull(key, vaultId, { repoName: 'app2', expected: preview.expected }))
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
    const preview = await m.sync.previewPull(key, vaultId, 'app1')
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
    const preview = await m.sync.previewPull(key, vaultId, 'app1')
    const req = { repoName: 'app1', expected: preview.expected }
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
    const preview = await a.sync.previewPush(key, vaultId, 'app1')
    expect(preview.needsOverwrite).toBe(true)
    expect(preview.diff.changed).toEqual(['A'])
    expect(
      await errorCode(
        a.sync.push(key, vaultId, {
          repoName: 'app1',
          overwriteConfirmed: false,
          expected: preview.expected
        })
      )
    ).toBe('OVERWRITE_NOT_CONFIRMED')
    await a.sync.push(key, vaultId, {
      repoName: 'app1',
      overwriteConfirmed: true,
      expected: preview.expected
    })
    expect((await rows(a))['app1']).toBe('in-sync')
  })

  it('refuses a pull if the vault changed after the preview', async () => {
    const a = await machine('a')
    const { key, vaultId } = await a.open()
    const preview = await a.sync.previewPull(key, vaultId, 'app2')
    const b = await machine('b')
    // B has no app2 folder, so write the entry by pushing from a temporary repo.
    makeRepo(projB, 'app2', { '.gitignore': '.env\n.env.bak.*\n', '.env': 'B=from-b\n' })
    await pushRepo(b, 'app2', true)
    const a2 = await machine('a')
    expect(
      await errorCode(a2.sync.pull(key, vaultId, { repoName: 'app2', expected: preview.expected }))
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

  async function stored(m: Machine): Promise<string> {
    const { key } = await m.open()
    const entry = await (await m.vault.vaultAt(vaultDir).snapshot()).read(key, 'local1')
    return Buffer.from(entry?.payload.envBase64 ?? '', 'base64').toString('utf8')
  }

  it('pushes marked keys blanked, and ignores local edits to them', async () => {
    const a = await machine('a')
    makeRepo(projA, 'local1', {
      '.gitignore': IGNORE,
      '.env': 'SHARED=1\n# envvault:local\nDB_PATH=/a/data\n'
    })
    const { key, vaultId } = await a.open()
    const preview = await a.sync.previewPush(key, vaultId, 'local1')
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
    const preview = await b.sync.previewPull(key, vaultId, 'local1')
    expect(preview.kept).toEqual(['DB_PATH'])
    expect(preview.unset).toEqual([])
    expect(preview.sameContent).toBe(false)
    expect(preview.diff).toEqual({ added: [], removed: [], changed: ['SHARED'], unchanged: 1 })

    // The raw diff shows what the pull writes, not the vault copy as stored.
    const raw = await b.sync.pullRawDiff(key, {
      repoName: 'local1',
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
    const preview = await a.sync.previewPush(key, vaultId, 'local1')
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
    expect(await errorCode(a.sync.previewPull(key, vaultId, 'local1'))).toBe('ENV_DUPLICATE_KEY')
    writeFileSync(envA(), 'SHARED=2\n# envvault:local\nDB_PATH=/a/other\n')
  })

  it('writes a marked key empty where this machine has no value', async () => {
    const b = await machine('b')
    rmSync(envB())
    const { key, vaultId } = await b.open()
    const preview = await b.sync.previewPull(key, vaultId, 'local1')
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
    expect((await a.sync.previewPush(key, vaultId, 'ex1')).example).toBeNull()
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
    expect((await a.sync.previewPush(key, vaultId, 'ex1')).example).toEqual({
      status: 'ok',
      tracked: false,
      sameValue: ['API_TOKEN'],
      missing: ['REDIS_URL'],
      undocumented: ['EXTRA']
    })
    git(dirA(), 'add', '.env.example')
    expect((await a.sync.previewPush(key, vaultId, 'ex1')).example).toMatchObject({
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
    const preview = await b.sync.previewPull(key, vaultId, 'ex1')
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
      expect((await a.sync.previewPush(key, vaultId, 'ex1')).example).toEqual({
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
    expect((await b.sync.previewPull(key, vaultId, 'ex1')).example).toBeNull()
    expect((await b.sync.previewPush(key, vaultId, 'ex1')).example).toBeNull()
    await b.config.updateConfig({ checkExample: true })
  })
})

describe('editing the vault copy', () => {
  const IGNORE = '.env\n.env.bak.*\n'
  const envA = (): string => join(projA, 'ed1', '.env')
  const ORIGINAL =
    '# shared\r\nexport API_URL=https://api.example.com\r\nSECRET="s3cret value" # rotate\r\n' +
    '# envvault:local\r\nDB_PATH=/a/data\r\nOLD=1\r\n'

  async function stored(m: Machine, id: string): Promise<string> {
    const { key } = await m.open()
    const entry = await (await m.vault.vaultAt(vaultDir).snapshot()).read(key, id)
    return Buffer.from(entry?.payload.envBase64 ?? '', 'base64').toString('utf8')
  }

  it('opens the vault copy as rows, with machine-specific values empty', async () => {
    const a = await machine('a')
    makeRepo(projA, 'ed1', { '.gitignore': IGNORE, '.env': ORIGINAL })
    await pushRepo(a, 'ed1')
    const { key } = await a.open()
    const data = await a.sync.openEditor(key, 'ed1')
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
    const { expectedVaultHash } = await a.sync.openEditor(key, 'ed1')
    const result = await a.sync.saveEdit(key, vaultId, {
      repoName: 'ed1',
      expectedVaultHash,
      set: [{ key: 'SECRET', value: 'new # secret' }],
      add: [{ key: 'NEW_KEY', value: 'line1\nline2' }],
      remove: ['OLD']
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
    const opened = await a.sync.openEditor((await a.open()).key, 'ed1')
    const b = await machine('b')
    makeRepo(projB, 'ed1', { '.gitignore': IGNORE, '.env': 'FROM_B=1\n' })
    await pushRepo(b, 'ed1', true)

    const a2 = await machine('a')
    const { key, vaultId } = await a2.open()
    const save = a2.sync.saveEdit(key, vaultId, {
      repoName: 'ed1',
      expectedVaultHash: opened.expectedVaultHash,
      set: [],
      add: [{ key: 'X', value: '1' }],
      remove: []
    })
    expect(await errorCode(save)).toBe('VAULT_CHANGED')
  })

  it('reports a save that changes nothing without writing a version', async () => {
    const a = await machine('a')
    const { key, vaultId } = await a.open()
    const opened = await a.sync.openEditor(key, 'ed1')
    const result = await a.sync.saveEdit(key, vaultId, {
      repoName: 'ed1',
      expectedVaultHash: opened.expectedVaultHash,
      set: [{ key: 'FROM_B', value: '1' }],
      add: [],
      remove: []
    })
    expect(result).toEqual({ vault: opened.vault, changed: false })
  })

  it('creates a vault copy for a repo with no .env', async () => {
    const a = await machine('a')
    makeRepo(projA, 'ed2', { '.gitignore': IGNORE })
    const { key, vaultId } = await a.open()
    expect(await a.sync.openEditor(key, 'ed2')).toEqual({
      entries: [],
      vault: null,
      expectedVaultHash: null
    })
    const empty = { repoName: 'ed2', expectedVaultHash: null, set: [], add: [], remove: [] }
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
    expect(await errorCode(a.sync.openEditor(key, 'ed3'))).toBe('ENV_DUPLICATE_KEY')

    const opened = await a.sync.openEditor(key, 'ed2')
    const err = await a.sync
      .saveEdit(key, vaultId, {
        repoName: 'ed2',
        expectedVaultHash: opened.expectedVaultHash,
        set: [{ key: 'MISSING_SECRET_KEY', value: 'hunter2-secret' }],
        add: [],
        remove: []
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
    expect(await b2.sync.autoPull(key, vaultId, 'ap1')).toMatchObject({
      name: 'ap1',
      status: 'in-sync',
      hasEnv: true,
      vault: { version: 2 }
    })
    expect(readFileSync(envB('ap1'), 'utf8')).toBe('A=2\n# envvault:local\nDB=/b\n')
    expect(backups('ap1')).toHaveLength(1)
    expect((await rows(b2))['ap1']).toBe('in-sync')
    expect(await b2.sync.autoPull(key, vaultId, 'ap1')).toBeNull()
  })

  it('leaves a conflict and a rollback alone', async () => {
    writeFileSync(envB('ap1'), 'A=2\nB_ONLY=1\n# envvault:local\nDB=/b\n')
    const a = await machine('a')
    writeFileSync(envA('ap1'), 'A=3\n# envvault:local\nDB=/a\n')
    await pushRepo(a, 'ap1')

    const b2 = await machine('b')
    const { key, vaultId } = await b2.open()
    expect((await rows(b2))['ap1']).toBe('conflict')
    expect(await b2.sync.autoPull(key, vaultId, 'ap1')).toBeNull()
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
    expect(await b3.sync.autoPull(k3.key, k3.vaultId, 'ap1')).toMatchObject({
      vault: { version: 4 }
    })

    // Someone puts v3 back: that's a rollback, never pulled automatically.
    writeFileSync(entry, v3)
    expect((await rows(b3))['ap1']).toBe('conflict')
    expect(await b3.sync.autoPull(k3.key, k3.vaultId, 'ap1')).toBeNull()
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
    expect(await b.sync.autoPull(key, vaultId, 'ap2')).toBeNull()
    expect(existsSync(envB('ap2'))).toBe(false)
  })

  it('creates a missing .env, both for a new clone and after it was deleted', async () => {
    const b = await machine('b')
    writeFileSync(join(projB, 'ap2', '.gitignore'), IGNORE)
    const { key, vaultId } = await b.open()
    expect(await b.sync.autoPull(key, vaultId, 'ap2')).toMatchObject({ status: 'in-sync' })
    expect(readFileSync(envB('ap2'), 'utf8')).toBe('X=1\n')

    rmSync(envB('ap2'))
    expect((await rows(b))['ap2']).toBe('vault-newer')
    expect(await b.sync.autoPull(key, vaultId, 'ap2')).toMatchObject({ status: 'in-sync' })
    expect(readFileSync(envB('ap2'), 'utf8')).toBe('X=1\n')
  })

  it('runs a pass only while unlocked and with the setting on (the default)', async () => {
    const a = await machine('a')
    writeFileSync(envA('ap2'), 'X=2\n')
    await pushRepo(a, 'ap2')

    const b = await machine('b')
    expect((await b.config.getConfig()).autoPull).toBe(true)
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
        expect(await cli.status.run({ dir })).toMatchObject([{ name: 'cl1', status: 'local-only' }])
      }
      expect(await cli.status.run({ repo: 'CL1' })).toMatchObject([{ name: 'cl1' }])
      expect((await cli.status.run({ all: true })).map((r) => r.name)).toContain('cl1')
      for (const dir of [root, projA, join(projA, 'not-a-repo'), join(projA, 'cl1', 'missing')]) {
        expect(await errorCode(cli.status.run({ dir }))).toBe('REPO_NOT_FOUND')
      }
      expect(await errorCode(cli.status.run({ repo: 'nope' }))).toBe('REPO_NOT_FOUND')
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
