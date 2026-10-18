// The vault's policy (src/main/vault.ts) on an in-memory store: states,
// create and open, and entries, with no filesystem involved.
import { describe, expect, it, vi } from 'vitest'
import { decodeEnv, encryptPayload, makePayload } from '../src/core/crypto'
import { MemoryStore } from '../src/main/store/memory'
import { vaultOn } from '../src/main/vault'

vi.mock('electron', () => ({ app: { getPath: () => '/nonexistent' } }))
vi.mock('../src/main/kdf', async () => {
  const { deriveKey } = await import('../src/core/crypto')
  return {
    deriveKeyInWorker: (job: { password: string; salt: Uint8Array }) =>
      deriveKey(job.password, job.salt, { opslimit: 1, memlimit: 8 * 1024 * 1024 })
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
  const bytes = await store.get(name)
  if (!bytes) throw new Error(`${name} is missing`)
  return bytes
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
    await store.put('web.env.enc', new Uint8Array([1, 2, 3]))
    expect(await vault.state()).toBe('meta-missing')
    expect(await errorCode(vault.create(PASSWORD))).toBe('VAULT_META_MISSING')

    await store.put('meta.json', Buffer.from('{not json'))
    expect(await vault.state()).toBe('ready')
    expect(await errorCode(vault.open(PASSWORD))).toBe('META_INVALID')
    await store.put('meta.json', Buffer.from('{"formatVersion":1}'))
    expect(await errorCode(vault.open(PASSWORD))).toBe('META_INVALID')
  })

  it('reports an unreachable store as a missing folder', async () => {
    const vault = vaultOn(new MemoryStore({ reachable: false }))
    expect(await vault.state()).toBe('folder-missing')
    expect(await errorCode(vault.create(PASSWORD))).toBe('VAULT_FOLDER_MISSING')
    expect(await errorCode(vault.open(PASSWORD))).toBe('VAULT_FOLDER_MISSING')
  })

  it('never creates over a vault that appears while the key is derived', async () => {
    // The second list() is the re-check after deriving the key.
    class AppearsMeanwhile extends MemoryStore {
      private calls = 0
      override async list(): Promise<string[]> {
        if (++this.calls === 2) await this.put('meta.json', THEIRS)
        return super.list()
      }
    }
    const store = new AppearsMeanwhile()
    expect(await errorCode(vaultOn(store).create(PASSWORD))).toBe('VAULT_EXISTS')
    expect(Buffer.from(await stored(store, 'meta.json')).equals(THEIRS)).toBe(true)
  })

  it('loses a create race to a vault that appears at the same moment', async () => {
    class RacingCreate extends MemoryStore {
      override async create(name: string, bytes: Uint8Array): Promise<void> {
        if (name === 'meta.json') await super.create(name, THEIRS)
        return super.create(name, bytes)
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
    const write = async (id: string, env: string): Promise<void> =>
      vault.write(id, await encryptPayload(key, id, makePayload(Buffer.from(env), 1, 'test')))
    await write('web', 'A=1\n')
    await write('api', 'B=2\n')
    await store.put('notes.txt', Buffer.from('not an entry'))

    expect((await vault.list()).sort()).toEqual(['api', 'web'])
    const web = await vault.read(key, 'web')
    expect(web && decodeEnv(web).toString('utf8')).toBe('A=1\n')
    expect(await vault.read(key, 'missing')).toBeNull()

    // The entry name is bound into the encryption: a copy under another name fails.
    await store.put('api.env.enc', await stored(store, 'web.env.enc'))
    expect(await errorCode(vault.read(key, 'api'))).toBe('VAULT_TAMPERED')

    const bytes = await stored(store, 'web.env.enc')
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1
    await store.put('web.env.enc', bytes)
    expect(await errorCode(vault.read(key, 'web'))).toBe('VAULT_TAMPERED')
  })
})
