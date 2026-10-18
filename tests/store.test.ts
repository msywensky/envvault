// The VaultStore contract (src/main/store/types.ts), run against every
// store, plus what only the folder store does.
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { storeFor } from '../src/main/store'
import { FolderStore } from '../src/main/store/folder'
import { MemoryStore } from '../src/main/store/memory'
import { StoreConflictError, type VaultStore } from '../src/main/store/types'

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

const kinds: [string, () => VaultStore, () => VaultStore][] = [
  ['folder', () => new FolderStore(folder()), () => new FolderStore(join(root, 'missing'))],
  ['memory', () => new MemoryStore(), () => new MemoryStore({ reachable: false })]
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
