// The VaultStore contract (src/main/store/types.ts), run against every
// store, plus what only the folder and git stores do. The git store runs
// against a local bare repository standing in for the remote.
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { AppError } from '../src/main/errors'
import { storeFor } from '../src/main/store'
import { FolderStore } from '../src/main/store/folder'
import { GitStore } from '../src/main/store/git'
import { MemoryStore } from '../src/main/store/memory'
import { StoreConflictError, type VaultStore } from '../src/main/store/types'

vi.mock('electron', () => ({ app: { getPath: () => '/nonexistent' } }))
// The git store runs a few git processes per call, and those start slowly on
// Windows (about 100 ms each in CI).
vi.setConfig({ testTimeout: 30_000 })

const root = mkdtempSync(join(tmpdir(), 'envvault-store-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

let n = 0
function folder(): string {
  const dir = join(root, `f${n++}`)
  mkdirSync(dir)
  return dir
}

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s)
const text = (b: Uint8Array | null | undefined): string | null =>
  b ? new TextDecoder().decode(b) : null

/** The object's current version, or null. */
async function versionOf(store: VaultStore, name: string): Promise<string | null> {
  return (await (await store.snapshot()).get(name))?.version ?? null
}

/** Its current bytes as text, or null. */
async function read(store: VaultStore, name: string): Promise<string | null> {
  return text((await (await store.snapshot()).get(name))?.bytes)
}

/** Write over whatever is there now. */
async function put(store: VaultStore, name: string, s: string): Promise<string> {
  return store.write(name, bytes(s), await versionOf(store, name))
}

/** A bare repository standing in for the remote, with no commits. */
function bareRemote(): string {
  const dir = join(root, `remote${n++}.git`)
  execFileSync('git', ['init', '--bare', '--quiet', dir])
  return dir
}

/** git in the remote, returning trimmed stdout. */
const inRemote = (remote: string, ...args: string[]): string =>
  execFileSync('git', ['--git-dir', remote, ...args], { encoding: 'utf8' }).trim()

/** A "machine": its own mirror of `remote`. */
const gitStore = (remote: string, cacheMs = 0): GitStore =>
  new GitStore({
    url: remote,
    branch: 'main',
    dir: join(root, `mirror${n++}.git`),
    allowLocal: true,
    cacheMs
  })

const kinds: [string, () => VaultStore, () => VaultStore][] = [
  ['folder', () => new FolderStore(folder()), () => new FolderStore(join(root, 'missing'))],
  ['memory', () => new MemoryStore(), () => new MemoryStore({ reachable: false })],
  ['git', () => gitStore(bareRemote()), () => gitStore(join(root, 'missing.git'))]
]

describe.each(kinds)('%s store', (_kind, make, unreachable) => {
  it('starts empty, reachable and usable', async () => {
    const store = make()
    expect(await store.reachable()).toBe(true)
    await store.check()
    const snapshot = await store.snapshot()
    expect(snapshot.names).toEqual([])
    expect(await snapshot.get('web.env.enc')).toBeNull()
    expect(await unreachable().reachable()).toBe(false)
  })

  it('creates with expected null, and never over an existing object', async () => {
    const store = make()
    await store.write('meta.json', bytes('first'), null)
    await expect(store.write('meta.json', bytes('second'), null)).rejects.toBeInstanceOf(
      StoreConflictError
    )
    expect(await read(store, 'meta.json')).toBe('first')
  })

  it('replaces at the current version only, returning the next one', async () => {
    const store = make()
    const v1 = await store.write('web.env.enc', bytes('one'), null)
    const v2 = await store.write('web.env.enc', bytes('two'), v1)
    expect(v2).not.toBe(v1)
    await expect(store.write('web.env.enc', bytes('stale'), v1)).rejects.toBeInstanceOf(
      StoreConflictError
    )
    expect(await read(store, 'web.env.enc')).toBe('two')
    // A version for an object that doesn't exist conflicts too.
    await expect(store.write('api.env.enc', bytes('x'), v1)).rejects.toBeInstanceOf(
      StoreConflictError
    )
    expect(await versionOf(store, 'api.env.enc')).toBeNull()
  })

  it('reads back the version a write returned, and lists what it holds', async () => {
    const store = make()
    const version = await store.write('web.env.enc', bytes('one'), null)
    await store.write('meta.json', bytes('{}'), null)
    const snapshot = await store.snapshot()
    expect([...snapshot.names].sort()).toEqual(['meta.json', 'web.env.enc'])
    const got = await snapshot.get('web.env.enc')
    expect(text(got?.bytes)).toBe('one')
    expect(got?.version).toBe(version)
  })

  it.each([
    ['nothing', null],
    ['a version', 'v1']
  ])('lets exactly one of several racing writes from %s win', async (_what, from) => {
    const store = make()
    const expected = from ? await store.write('web.env.enc', bytes('start'), null) : null
    const results = await Promise.allSettled(
      [0, 1, 2, 3, 4].map((i) => store.write('web.env.enc', bytes(`machine ${i}`), expected))
    )
    const won = results.flatMap((r, i) => (r.status === 'fulfilled' ? [i] : []))
    expect(won).toHaveLength(1)
    for (const r of results) {
      if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(StoreConflictError)
    }
    expect(await read(store, 'web.env.enc')).toBe(`machine ${won[0]}`)
  })

  it('keeps its own copy of the bytes', async () => {
    const store = make()
    const input = bytes('secret')
    await store.write('web.env.enc', input, null)
    input.fill(0)
    const out = await (await store.snapshot()).get('web.env.enc')
    out?.bytes.fill(0)
    expect(await read(store, 'web.env.enc')).toBe('secret')
  })

  it('rejects names that are not one lowercase segment', async () => {
    const store = make()
    const snapshot = await store.snapshot()
    for (const name of ['', '../x', '.hidden', 'a/b', 'a\\b', 'a b', 'A.env.enc', 'web.']) {
      await expect(snapshot.get(name), name).rejects.toThrow('Not a valid store name.')
      await expect(store.write(name, bytes('x'), null), name).rejects.toThrow(
        'Not a valid store name.'
      )
    }
    expect((await store.snapshot()).names).toEqual([])
  })

  it('can always clean up', async () => {
    const store = make()
    await store.cleanUp()
    await put(store, 'web.env.enc', 'x')
    await store.cleanUp()
    expect(await read(store, 'web.env.enc')).toBe('x')
  })
})

describe('folder store only', () => {
  it('lists neither its temp files nor Drive conflict copies', async () => {
    const dir = folder()
    const store = new FolderStore(dir)
    await put(store, 'web.env.enc', 'x')
    writeFileSync(join(dir, '.web.env.enc.0123456789abcdef.tmp'), 'partial')
    writeFileSync(join(dir, 'web.env (1).enc'), 'conflict copy')
    writeFileSync(join(dir, 'Notes.txt'), 'user file')
    expect((await store.snapshot()).names).toEqual(['web.env.enc'])
  })

  it('removes only stale temp files of its own', async () => {
    const dir = folder()
    const store = new FolderStore(dir)
    const old = new Date(Date.now() - 60 * 60_000)
    const files = {
      stale: '.web.env.enc.0123456789abcdef.tmp',
      fresh: '.web.env.enc.fedcba9876543210.tmp',
      foreign: '.other-file.tmp',
      shortHex: '.web.env.enc.0123.tmp'
    }
    for (const f of Object.values(files)) writeFileSync(join(dir, f), 'x')
    for (const f of [files.stale, files.foreign, files.shortHex]) utimesSync(join(dir, f), old, old)
    await store.cleanUp()
    expect(readdirSync(dir).sort()).toEqual([files.shortHex, files.foreign, files.fresh].sort())
  })

  it('writes atomically, leaving no temp file behind', async () => {
    const dir = folder()
    const store = new FolderStore(dir)
    await put(store, 'web.env.enc', 'x')
    expect(readdirSync(dir)).toEqual(['web.env.enc'])
  })

  it('notices a file that changed outside the store (synced in by Drive)', async () => {
    const dir = folder()
    const store = new FolderStore(dir)
    const version = await put(store, 'web.env.enc', 'ours')
    writeFileSync(join(dir, 'web.env.enc'), 'theirs')
    await expect(store.write('web.env.enc', bytes('mine'), version)).rejects.toBeInstanceOf(
      StoreConflictError
    )
    writeFileSync(join(dir, 'meta.json'), 'theirs')
    await expect(store.write('meta.json', bytes('mine'), null)).rejects.toBeInstanceOf(
      StoreConflictError
    )
    expect(await read(store, 'web.env.enc')).toBe('theirs')
  })

  it('is one store per folder', () => {
    const dir = folder()
    expect(storeFor({ kind: 'folder', path: dir })).toBe(
      storeFor({ kind: 'folder', path: join(dir, '.') })
    )
    expect(storeFor({ kind: 'folder', path: dir })).not.toBe(
      storeFor({ kind: 'folder', path: folder() })
    )
  })
})

describe('git store only', () => {
  const WEB = 'web.env.enc'

  it('creates the branch with its first write, and keeps history', async () => {
    const remote = bareRemote()
    const store = gitStore(remote)
    await store.check()
    expect((await store.snapshot()).names).toEqual([])
    const v1 = await store.write(WEB, bytes('one'), null)
    await store.write(WEB, bytes('two'), v1)
    expect(inRemote(remote, 'rev-list', '--count', 'main')).toBe('2')
    expect(inRemote(remote, 'show', `main~1:${WEB}`)).toBe('one')
    expect(inRemote(remote, 'show', `main:${WEB}`)).toBe('two')
  })

  it('works between two machines: conflicts on the same file, builds on top of others', async () => {
    const remote = bareRemote()
    const a = gitStore(remote)
    // Machine b reuses what it last saw, so it starts out of date.
    const b = gitStore(remote, 60_000)
    const v1 = await a.write(WEB, bytes('one'), null)
    expect(await versionOf(b, WEB)).toBe(v1)
    const v2 = await a.write(WEB, bytes('two'), v1)

    await expect(b.write(WEB, bytes('stale'), v1)).rejects.toBeInstanceOf(StoreConflictError)
    await b.write('api.env.enc', bytes('api'), null)
    expect(inRemote(remote, 'show', `main:${WEB}`)).toBe('two')
    expect(inRemote(remote, 'show', 'main:api.env.enc')).toBe('api')
    expect(await versionOf(a, WEB)).toBe(v2)
    expect((await a.snapshot()).names.sort()).toEqual(['api.env.enc', WEB])
  })

  it('refuses a write when the branch moved back since it was read (a lease, not just a fast-forward)', async () => {
    const remote = bareRemote()
    const store = gitStore(remote, 60_000)
    const v1 = await store.write(WEB, bytes('one'), null)
    const first = inRemote(remote, 'rev-parse', 'main')
    const v2 = await store.write(WEB, bytes('two'), v1)
    // Someone resets the branch. A plain push of a commit on top of "two"
    // would still be a fast-forward, and bring "two" back.
    inRemote(remote, 'update-ref', 'refs/heads/main', first)
    await expect(store.write(WEB, bytes('three'), v2)).rejects.toBeInstanceOf(StoreConflictError)
    expect(inRemote(remote, 'rev-parse', 'main')).toBe(first)
  })

  it('sees its own write at once, even while reusing a listing', async () => {
    const store = gitStore(bareRemote(), 60_000)
    expect((await store.snapshot()).names).toEqual([])
    const version = await store.write(WEB, bytes('one'), null)
    expect(await versionOf(store, WEB)).toBe(version)
  })

  it('takes snapshots side by side', async () => {
    const remote = bareRemote()
    await gitStore(remote).write(WEB, bytes('one'), null)
    const fresh = gitStore(remote)
    const snapshots = await Promise.all([0, 1, 2, 3, 4].map(() => fresh.snapshot()))
    for (const s of snapshots) expect(s.names).toEqual([WEB])
  })

  it('ignores README.md, directories and links, and keeps them through writes', async () => {
    const remote = bareRemote()
    const work = join(root, `work${n++}`)
    mkdirSync(join(work, 'docs'), { recursive: true })
    writeFileSync(join(work, 'README.md'), '# Vault\n')
    writeFileSync(join(work, 'docs', 'web.env.enc'), 'not an entry')
    const g = (...args: string[]): void => {
      execFileSync('git', [
        '-C',
        work,
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@example.com',
        ...args
      ])
    }
    g('init', '--quiet')
    g('add', '.')
    // A symlink named like an entry: its blob is a path, not a file.
    const link = execFileSync('git', ['-C', work, 'hash-object', '-w', '--stdin'], {
      input: 'README.md'
    })
      .toString()
      .trim()
    g('update-index', '--add', '--cacheinfo', `120000,${link},api.env.enc`)
    g('commit', '--quiet', '-m', 'seed')
    g('push', '--quiet', remote, 'HEAD:refs/heads/main')

    const store = gitStore(remote)
    expect((await store.snapshot()).names).toEqual([])
    await store.write(WEB, bytes('one'), null)
    expect(inRemote(remote, 'ls-tree', '--name-only', 'main').split('\n').sort()).toEqual(
      ['README.md', 'api.env.enc', 'docs', WEB].sort()
    )
    expect(inRemote(remote, 'show', 'main:docs/web.env.enc')).toBe('not an entry')
  })

  it('commits as EnvVault, never as you or your machine', async () => {
    const remote = bareRemote()
    await gitStore(remote).write(WEB, bytes('one'), null)
    expect(inRemote(remote, 'log', '-1', '--format=%an <%ae>|%cn <%ce>|%s', 'main')).toBe(
      'EnvVault <envvault@users.noreply.invalid>|EnvVault <envvault@users.noreply.invalid>|EnvVault update'
    )
  })

  it("doesn't run your global hooks in its mirror", async () => {
    const hooks = join(root, `hooks${n++}`)
    const marker = join(root, `hook-ran${n++}`)
    mkdirSync(hooks)
    for (const hook of ['pre-push', 'reference-transaction', 'post-checkout']) {
      const file = join(hooks, hook)
      writeFileSync(file, `#!/bin/sh\necho "${hook} $(pwd)" >> "${marker.replace(/\\/g, '/')}"\n`)
      chmodSync(file, 0o755)
    }
    const globalConfig = join(root, `global${n++}.gitconfig`)
    writeFileSync(globalConfig, `[core]\n\thooksPath = ${hooks.replace(/\\/g, '/')}\n`)
    const ran = (): string[] =>
      existsSync(marker) ? readFileSync(marker, 'utf8').trim().split('\n') : []
    const saved = process.env['GIT_CONFIG_GLOBAL']
    process.env['GIT_CONFIG_GLOBAL'] = globalConfig
    try {
      // Plain git does run them, so the test can tell.
      const remote = bareRemote()
      const work = join(root, `work${n++}`)
      const g = (...args: string[]): void => {
        execFileSync('git', [
          '-C',
          work,
          '-c',
          'user.name=t',
          '-c',
          'user.email=t@example.com',
          ...args
        ])
      }
      execFileSync('git', ['init', '--quiet', work])
      g('commit', '--quiet', '--allow-empty', '-m', 'x')
      g('push', '--quiet', remote, 'HEAD:refs/heads/other')
      expect(ran().some((line) => line.startsWith('pre-push '))).toBe(true)
      rmSync(marker)

      // A local remote shares this machine's global config, so its own
      // (server-side) hooks may run; only the mirror's must not.
      const mirror = join(root, `mirror${n++}.git`)
      const store = new GitStore({ url: remote, branch: 'main', dir: mirror, allowLocal: true })
      const v1 = await store.write(WEB, bytes('one'), null)
      await store.write(WEB, bytes('two'), v1)
      await store.cleanUp()
      const where = [mirror, realpathSync(mirror)].map((p) => p.replace(/\\/g, '/'))
      const inMirror = (line: string): boolean =>
        line.startsWith('pre-push ') || where.some((p) => line.replace(/\\/g, '/').includes(p))
      expect(ran().filter(inMirror)).toEqual([])
    } finally {
      if (saved === undefined) delete process.env['GIT_CONFIG_GLOBAL']
      else process.env['GIT_CONFIG_GLOBAL'] = saved
    }
  })

  it('refuses a missing branch in a repository that has others', async () => {
    const remote = bareRemote()
    await new GitStore({
      url: remote,
      branch: 'other',
      dir: join(root, `mirror${n++}.git`),
      allowLocal: true,
      cacheMs: 0
    }).write(WEB, bytes('x'), null)
    await expect(gitStore(remote).check()).rejects.toMatchObject({
      code: 'GIT_VAULT_BRANCH_MISSING'
    })
  })

  it('is unusable with a URL or branch that would not be accepted', async () => {
    for (const [url, branch] of [
      ['file:///tmp/vault.git', 'main'],
      ['https://github.com/you/vault.git', '-main']
    ] as const) {
      const store = new GitStore({ url, branch, dir: join(root, `mirror${n++}.git`) })
      expect(await store.reachable()).toBe(false)
      await expect(store.snapshot()).rejects.toMatchObject({ code: 'GIT_VAULT_INVALID_URL' })
      await expect(store.write(WEB, bytes('x'), null)).rejects.toMatchObject({
        code: 'GIT_VAULT_INVALID_URL'
      })
    }
  })

  it('refuses a repository the privacy check does not confirm as private', async () => {
    const remote = bareRemote()
    for (const code of ['GIT_VAULT_PUBLIC', 'GIT_VAULT_UNVERIFIED'] as const) {
      const asked: string[] = []
      const store = new GitStore({
        url: remote,
        branch: 'main',
        dir: join(root, `mirror${n++}.git`),
        allowLocal: true,
        checkPrivacy: async (url) => {
          asked.push(url)
          throw new AppError(code, 'no')
        }
      })
      await expect(store.check()).rejects.toMatchObject({ code })
      expect(asked).toEqual([remote])
    }
  })

  it('reports an unreachable remote', async () => {
    const store = gitStore(join(root, 'no-such-remote.git'))
    await expect(store.snapshot()).rejects.toMatchObject({ code: 'GIT_VAULT_UNREACHABLE' })
    await expect(store.check()).rejects.toMatchObject({ code: 'GIT_VAULT_UNREACHABLE' })
  })
})
