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
  vault: typeof import('../src/main/vault')
  sync: typeof import('../src/main/sync')
  session: typeof import('../src/main/session')
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
  await config.updateConfig({ projectsPath: name === 'a' ? projA : projB, vaultPath: vaultDir })
  const open = (): Promise<{ key: Uint8Array; vaultId: string }> =>
    vault.openVault(vaultDir, PASSWORD)
  return { vault, sync, session, open }
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
    expect(await m.vault.folderState(vaultDir)).toBe('empty')
    expect(await errorCode(m.vault.createVault(vaultDir, 'short'))).toBe('PASSWORD_TOO_SHORT')
    await m.vault.createVault(vaultDir, PASSWORD)
    expect(await m.vault.folderState(vaultDir)).toBe('ready')
    expect(await errorCode(m.vault.createVault(vaultDir, PASSWORD))).toBe('VAULT_EXISTS')
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
    expect(await errorCode(m.vault.openVault(vaultDir, 'wrong password!!'))).toBe('WRONG_PASSWORD')
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
    expect(await m.vault.folderState(vaultDir)).toBe('meta-missing')
    expect(await errorCode(m.vault.createVault(vaultDir, PASSWORD))).toBe('VAULT_META_MISSING')
    renameSync(join(root, 'meta.json.bak'), join(vaultDir, 'meta.json'))
  })

  it('reports a missing vault folder instead of offering to create one', async () => {
    const m = await machine('a')
    expect(await m.vault.folderState(join(root, 'no-such-folder'))).toBe('folder-missing')
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
