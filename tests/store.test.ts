// The VaultStore contract (src/main/store/types.ts), run against every
// store, plus what only the folder store does.
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { FolderStore } from '../src/main/store/folder'
import { MemoryStore } from '../src/main/store/memory'
import { StoreExistsError, type VaultStore } from '../src/main/store/types'

const root = mkdtempSync(join(tmpdir(), 'envvault-store-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

let n = 0
function folder(): string {
  const dir = join(root, `f${n++}`)
  mkdirSync(dir)
  return dir
}

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s)
const text = (b: Uint8Array | null): string | null => (b ? new TextDecoder().decode(b) : null)

const kinds: [string, () => VaultStore, () => VaultStore][] = [
  ['folder', () => new FolderStore(folder()), () => new FolderStore(join(root, 'missing'))],
  ['memory', () => new MemoryStore(), () => new MemoryStore({ reachable: false })]
]

describe.each(kinds)('%s store', (_kind, make, unreachable) => {
  it('starts empty and reachable', async () => {
    const store = make()
    expect(await store.reachable()).toBe(true)
    expect(await store.list()).toEqual([])
    expect(await store.get('web.env.enc')).toBeNull()
    expect(await unreachable().reachable()).toBe(false)
  })

  it('puts, replaces and lists objects', async () => {
    const store = make()
    await store.put('web.env.enc', bytes('one'))
    expect(text(await store.get('web.env.enc'))).toBe('one')
    await store.put('web.env.enc', bytes('two'))
    expect(text(await store.get('web.env.enc'))).toBe('two')
    await store.put('meta.json', bytes('{}'))
    expect((await store.list()).sort()).toEqual(['meta.json', 'web.env.enc'])
  })

  it('creates exclusively, keeping what was there', async () => {
    const store = make()
    await store.create('meta.json', bytes('first'))
    await expect(store.create('meta.json', bytes('second'))).rejects.toBeInstanceOf(
      StoreExistsError
    )
    expect(text(await store.get('meta.json'))).toBe('first')
  })

  it('lets exactly one of several racing creates win', async () => {
    const store = make()
    const results = await Promise.allSettled(
      [0, 1, 2, 3, 4].map((i) => store.create('meta.json', bytes(`machine ${i}`)))
    )
    const won = results.flatMap((r, i) => (r.status === 'fulfilled' ? [i] : []))
    expect(won).toHaveLength(1)
    for (const r of results) {
      if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(StoreExistsError)
    }
    expect(text(await store.get('meta.json'))).toBe(`machine ${won[0]}`)
  })

  it('keeps its own copy of the bytes', async () => {
    const store = make()
    const input = bytes('secret')
    await store.put('web.env.enc', input)
    input.fill(0)
    const out = await store.get('web.env.enc')
    out?.fill(0)
    expect(text(await store.get('web.env.enc'))).toBe('secret')
  })

  it('rejects names that are not one lowercase segment', async () => {
    const store = make()
    for (const name of ['', '../x', '.hidden', 'a/b', 'a\\b', 'a b', 'A.env.enc', 'web.']) {
      await expect(store.get(name), name).rejects.toThrow('Not a valid store name.')
      await expect(store.put(name, bytes('x')), name).rejects.toThrow('Not a valid store name.')
      await expect(store.create(name, bytes('x')), name).rejects.toThrow('Not a valid store name.')
    }
    expect(await store.list()).toEqual([])
  })

  it('can always clean up', async () => {
    const store = make()
    await store.cleanUp()
    await store.put('web.env.enc', bytes('x'))
    await store.cleanUp()
    expect(text(await store.get('web.env.enc'))).toBe('x')
  })
})

describe('folder store only', () => {
  it('lists neither its temp files nor Drive conflict copies', async () => {
    const dir = folder()
    const store = new FolderStore(dir)
    await store.put('web.env.enc', bytes('x'))
    writeFileSync(join(dir, '.web.env.enc.0123456789abcdef.tmp'), 'partial')
    writeFileSync(join(dir, 'web.env (1).enc'), 'conflict copy')
    writeFileSync(join(dir, 'Notes.txt'), 'user file')
    expect(await store.list()).toEqual(['web.env.enc'])
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
    await store.put('web.env.enc', bytes('x'))
    expect(readdirSync(dir)).toEqual(['web.env.enc'])
  })
})
