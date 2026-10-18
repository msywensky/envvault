// The vault's policy (src/main/vault.ts) on an in-memory store: states,
// create and open, and entries, with no filesystem involved.
import { describe, expect, it, vi } from 'vitest'
import { decodeEnv, encryptPayload, makePayload } from '../src/core/crypto'
import { AppError } from '../src/main/errors'
import { MemoryStore } from '../src/main/store/memory'
import type { StoreSnapshot } from '../src/main/store/types'
import { vaultOn } from '../src/main/vault'

const h = vi.hoisted(() => ({ derives: 0 }))

vi.mock('electron', () => ({ app: { getPath: () => '/nonexistent' } }))
vi.mock('../src/main/kdf', async () => {
  const { deriveKey } = await import('../src/core/crypto')
  return {
    deriveKeyInWorker: (job: { password: string; salt: Uint8Array }) => {
      h.derives++
      return deriveKey(job.password, job.salt, { opslimit: 1, memlimit: 8 * 1024 * 1024 })
    }
  }
})

const PASSWORD = 'correct horse battery staple'
const THEIRS = Buffer.from('{"theirs":true}\n')

const errorCode = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p
  } catch (err) {
    return (err as { code?: string }).code ?? String(err)
  }
  return 'no error'
}

async function stored(store: MemoryStore, name: string): Promise<Uint8Array> {
  const found = await (await store.snapshot()).get(name)
  if (!found) throw new Error(`${name} is missing`)
  return found.bytes
}

/** Write over whatever the store holds now. */
async function put(store: MemoryStore, name: string, bytes: Uint8Array): Promise<void> {
  const current = await (await store.snapshot()).get(name)
  await store.write(name, bytes, current?.version ?? null)
}

describe('vault policy on a memory store', () => {
  it('goes from empty to ready, and opens with the right password only', async () => {
    const vault = vaultOn(new MemoryStore())
    expect(await vault.state()).toBe('empty')
    expect(await errorCode(vault.open(PASSWORD))).toBe('VAULT_NOT_FOUND')
    expect(await errorCode(vault.create('too short'))).toBe('PASSWORD_TOO_SHORT')

    const created = await vault.create(PASSWORD)
    expect(await vault.state()).toBe('ready')
    expect(await errorCode(vault.create(PASSWORD))).toBe('VAULT_EXISTS')

    const opened = await vault.open(PASSWORD)
    expect(opened.vaultId).toBe(created.vaultId)
    expect(Buffer.from(opened.key).equals(Buffer.from(created.key))).toBe(true)
    expect(await errorCode(vault.open('wrong password!!'))).toBe('WRONG_PASSWORD')
  })

  it('refuses a vault whose meta.json is missing or invalid', async () => {
    const store = new MemoryStore()
    const vault = vaultOn(store)
    await put(store, 'web.env.enc', new Uint8Array([1, 2, 3]))
    expect(await vault.state()).toBe('meta-missing')
    expect(await errorCode(vault.create(PASSWORD))).toBe('VAULT_META_MISSING')

    await put(store, 'meta.json', Buffer.from('{not json'))
    expect(await vault.state()).toBe('ready')
    expect(await errorCode(vault.open(PASSWORD))).toBe('META_INVALID')
    await put(store, 'meta.json', Buffer.from('{"formatVersion":1}'))
    expect(await errorCode(vault.open(PASSWORD))).toBe('META_INVALID')
  })

  it('reports an unreachable store as a missing folder', async () => {
    const vault = vaultOn(new MemoryStore({ reachable: false }))
    expect(await vault.state()).toBe('folder-missing')
    expect(await errorCode(vault.create(PASSWORD))).toBe('VAULT_FOLDER_MISSING')
    expect(await errorCode(vault.open(PASSWORD))).toBe('VAULT_FOLDER_MISSING')
  })

  it('asks the store before creating or opening, and stops before deriving a key', async () => {
    class Refuses extends MemoryStore {
      refuse = false
      override async check(): Promise<void> {
        if (this.refuse) throw new AppError('INTERNAL', 'Not now.')
      }
    }
    const store = new Refuses()
    const vault = vaultOn(store)
    store.refuse = true
    const before = h.derives
    expect(await errorCode(vault.create(PASSWORD))).toBe('INTERNAL')
    expect(await vault.state()).toBe('empty')
    store.refuse = false
    await vault.create(PASSWORD)
    store.refuse = true
    expect(await errorCode(vault.open(PASSWORD))).toBe('INTERNAL')
    expect(h.derives).toBe(before + 1)
  })

  it('never creates over a vault that appears while the key is derived', async () => {
    // The second snapshot is the re-check after deriving the key.
    class AppearsMeanwhile extends MemoryStore {
      private calls = 0
      override async snapshot(): Promise<StoreSnapshot> {
        if (++this.calls === 2) await this.write('meta.json', THEIRS, null)
        return super.snapshot()
      }
    }
    const store = new AppearsMeanwhile()
    expect(await errorCode(vaultOn(store).create(PASSWORD))).toBe('VAULT_EXISTS')
    expect(Buffer.from(await stored(store, 'meta.json')).equals(THEIRS)).toBe(true)
  })

  it('loses a create race to a vault that appears at the same moment', async () => {
    class RacingCreate extends MemoryStore {
      override async write(
        name: string,
        bytes: Uint8Array,
        expected: string | null
      ): Promise<string> {
        if (name === 'meta.json') await super.write(name, THEIRS, null)
        return super.write(name, bytes, expected)
      }
    }
    const store = new RacingCreate()
    expect(await errorCode(vaultOn(store).create(PASSWORD))).toBe('VAULT_EXISTS')
    expect(Buffer.from(await stored(store, 'meta.json')).equals(THEIRS)).toBe(true)
  })

  it('reads back what it wrote, and catches tampered and swapped entries', async () => {
    const store = new MemoryStore()
    const vault = vaultOn(store)
    const { key } = await vault.create(PASSWORD)
    const write = async (id: string, env: string): Promise<string> =>
      vault.write(id, await encryptPayload(key, id, makePayload(Buffer.from(env), 1, 'test')), null)
    const webVersion = await write('web', 'A=1\n')
    await write('api', 'B=2\n')
    await put(store, 'notes.txt', Buffer.from('not an entry'))

    const snapshot = await vault.snapshot()
    expect([...snapshot.ids].sort()).toEqual(['api', 'web'])
    const web = await snapshot.read(key, 'web')
    expect(web && decodeEnv(web.payload).toString('utf8')).toBe('A=1\n')
    expect(web?.version).toBe(webVersion)
    expect(await snapshot.read(key, 'missing')).toBeNull()

    // The entry name is bound into the encryption: a copy under another name fails.
    await put(store, 'api.env.enc', await stored(store, 'web.env.enc'))
    expect(await errorCode((await vault.snapshot()).read(key, 'api'))).toBe('VAULT_TAMPERED')

    const bytes = await stored(store, 'web.env.enc')
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1
    await put(store, 'web.env.enc', bytes)
    expect(await errorCode((await vault.snapshot()).read(key, 'web'))).toBe('VAULT_TAMPERED')
  })

  it('refuses to write over an entry that changed since its snapshot', async () => {
    const store = new MemoryStore()
    const vault = vaultOn(store)
    const { key } = await vault.create(PASSWORD)
    const encrypt = async (env: string): Promise<Uint8Array> =>
      encryptPayload(key, 'web', makePayload(Buffer.from(env), 1, 'test'))
    const v1 = await vault.write('web', await encrypt('A=1\n'), null)
    const before = await vault.snapshot()
    await vault.write('web', await encrypt('A=2\n'), v1)

    const entry = await before.read(key, 'web')
    expect(entry?.version).toBe(v1)
    expect(await errorCode(vault.write('web', await encrypt('A=3\n'), v1))).toBe('VAULT_CHANGED')
    expect(await errorCode(vault.write('web', await encrypt('A=3\n'), null))).toBe('VAULT_CHANGED')
    const now = await (await vault.snapshot()).read(key, 'web')
    expect(now && decodeEnv(now.payload).toString('utf8')).toBe('A=2\n')
  })
})
