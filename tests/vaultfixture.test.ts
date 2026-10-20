// A vault written by main at c3e2e1c, the format vaults are in today:
// meta.json format 2 (setup code), a root .env entry, a file entry and
// settings.enc, with the real KDF parameters. Never regenerate it: if this
// fails, existing vaults no longer open.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { decodeEnv, makePayload, sha256Hex } from '../src/core/crypto'
import { ROOT_ENV } from '../src/core/envpath'
import { MemorySecrets } from '../src/main/secrets'
import { MemoryStore } from '../src/main/store/memory'
import { entryFor, vaultOn, withEntryKeys, type EntryRef, type Vault } from '../src/main/vault'

vi.mock('electron', () => ({ app: { getPath: () => '/nonexistent' } }))
// The parameters meta.json asks for, unlike the other tests' fast ones.
vi.mock('../src/main/kdf', async () => {
  const { deriveKey } = await import('../src/core/crypto')
  return {
    deriveKeyInWorker: (job: {
      password: string
      salt: Uint8Array
      kdf: { opslimit: number; memlimit: number }
    }) => deriveKey(job.password, job.salt, job.kdf)
  }
})

const DIR = join(__dirname, 'fixtures', 'vault-format2')
const PASSWORD = 'quiet lantern orbit before release'
const SETUP_CODE = 'EV-GAVCP-4B6JC-3KZJN-1JBCY-2574Z-D62E'
const VAULT_ID = '8d997f73-95f2-4d83-89ed-7e6f73b24a3d'
const AT = '2026-10-19T12:00:00.000Z'
const ROOT = { repoName: 'Fixture-App', path: ROOT_ENV }
const WEB = { repoName: 'Fixture-App', path: 'apps/web/.env' }
const ROOT_TEXT =
  '# Root .env of the fixture repo\nAPI_URL=https://api.example.test\n# envvault:local\nDATA_DIR=\nTOKEN="fixture-root-token"\n'
const WEB_TEXT = 'NEXT_PUBLIC_SITE=https://web.example.test\nWEB_SECRET=fixture-web-secret\n'

const errorCode = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p
  } catch (err) {
    return (err as { code?: string }).code ?? String(err)
  }
  return 'no error'
}

async function fixtureStore(): Promise<MemoryStore> {
  const store = new MemoryStore()
  for (const name of readdirSync(DIR)) {
    await store.write(name, new Uint8Array(readFileSync(join(DIR, name))), null)
  }
  return store
}

describe('a vault in the current format', { timeout: 30_000 }, () => {
  let vault: Vault
  let key: Uint8Array

  beforeAll(async () => {
    vault = vaultOn(await fixtureStore(), new MemorySecrets())
    expect(await vault.state()).toBe('ready')
    expect(await vault.setupCodeState()).toBe('needed')
    // Both refused before the key is derived.
    expect(await errorCode(vault.open(PASSWORD))).toBe('SETUP_CODE_REQUIRED')
    expect(await errorCode(vault.open(PASSWORD, 'EV-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA-AAAA'))).toMatch(
      /^SETUP_CODE_(WRONG|INVALID)$/
    )
    const opened = await vault.open(PASSWORD, SETUP_CODE)
    expect(opened.vaultId).toBe(VAULT_ID)
    expect(await vault.setupCodeState()).toBe('saved')
    key = opened.key
  })

  it('lists and decrypts the root entry and the file entry', async () => {
    await withEntryKeys(key, async (keys) => {
      const snapshot = await vault.snapshot()
      const rootRef = entryFor(keys, ROOT)
      const webRef = entryFor(keys, WEB)
      // The file tag is still derived the same way.
      expect(webRef).toEqual({ kind: 'file', repoId: 'fixture-app', tag: '1ade501d8ff0d0f6' })
      expect(snapshot.entries).toHaveLength(2)
      expect(snapshot.entries).toEqual(expect.arrayContaining<EntryRef>([rootRef, webRef]))

      const root = await snapshot.read(keys, rootRef)
      expect(root?.path).toBe(ROOT_ENV)
      expect(root?.payload).toMatchObject({
        version: 3,
        updatedBy: 'fixture-machine',
        updatedAt: AT,
        contentHash: sha256Hex(Buffer.from(ROOT_TEXT))
      })
      expect(root && decodeEnv(root.payload).toString('utf8')).toBe(ROOT_TEXT)

      const web = await snapshot.read(keys, webRef)
      expect(web?.path).toBe(WEB.path)
      expect(web?.payload).toMatchObject({ version: 2, updatedBy: 'fixture-machine' })
      expect(web && decodeEnv(web.payload).toString('utf8')).toBe(WEB_TEXT)
    })
  })

  it('reads the repo settings', async () => {
    await withEntryKeys(key, async (keys) => {
      const read = await (await vault.snapshot()).settings(keys)
      expect(read.error).toBeNull()
      expect(read.version).not.toBeNull()
      expect(read.settings).toEqual({
        format: 1,
        updatedBy: 'fixture-machine',
        updatedAt: AT,
        defaults: { include: ['.env', '.env.local'], exclude: [] },
        repos: { 'fixture-app': { exclude: ['apps/docs'] }, archived: { ignored: true } }
      })
    })
  })

  it('takes new versions on top of it', async () => {
    await withEntryKeys(key, async (keys) => {
      const before = await vault.snapshot()
      const root = await before.read(keys, entryFor(keys, ROOT))
      const settings = await before.settings(keys)
      if (!root || !settings.version) throw new Error('fixture entries missing')
      const next = 'API_URL=https://api.example.test/v2\n'
      await vault.write(keys, ROOT, makePayload(Buffer.from(next), 4, 'test'), root.version)
      const doc = { ...settings.settings, repos: {} }
      await vault.writeSettings(keys, doc, settings.version)

      const after = await vault.snapshot()
      const written = await after.read(keys, entryFor(keys, ROOT))
      expect(written?.payload.version).toBe(4)
      expect(written && decodeEnv(written.payload).toString('utf8')).toBe(next)
      expect((await after.settings(keys)).settings.repos).toEqual({})
      // The file entry is untouched.
      expect((await after.read(keys, entryFor(keys, WEB)))?.payload.version).toBe(2)
    })
  })
})
