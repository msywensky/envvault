// Merge bases (src/main/bases.ts): what this machine last synced of each env
// file, sealed under a key derived from the vault key.
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { deriveKey, randomSalt, sha256Hex } from '../src/core/crypto'

const h = vi.hoisted(() => ({ userData: '' }))

vi.mock('electron', () => ({ app: { getPath: () => h.userData } }))

const root = mkdtempSync(join(tmpdir(), 'envvault-bases-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const VAULT = '3f1c2b8e-5d4a-4c3b-9a2e-1f0e9d8c7b6a'
const OTHER = '9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d'
const ID = 'webapp/0123456789abcdef'
const bytes = Buffer.from('# base\nA=1\nSECRET=s3cret\n')
const last = { version: 3, contentHash: sha256Hex(bytes) }
const key = async (): Promise<Uint8Array> =>
  deriveKey('correct horse', await randomSalt(), { opslimit: 1, memlimit: 8 * 1024 * 1024 })
const dir = (vaultId = VAULT): string => join(h.userData, 'bases', vaultId)

let n = 0
beforeEach(() => {
  h.userData = mkdtempSync(join(root, `u${n++}-`))
  vi.resetModules()
})

const load = async (): Promise<typeof import('../src/main/bases')> => import('../src/main/bases')

describe('merge bases', () => {
  it('saves, loads and forgets a base, sealed, with no names on disk', async () => {
    const { forgetBase, loadBase, saveBase } = await load()
    const k = await key()
    expect(await loadBase(k, VAULT, ID, last)).toBeNull()
    await saveBase(k, VAULT, ID, last, bytes)
    expect((await loadBase(k, VAULT, ID, last))?.toString()).toBe(bytes.toString())

    const files = readdirSync(dir())
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/^[0-9a-f]{32}\.enc$/)
    if (process.platform !== 'win32') {
      expect(statSync(dir()).mode & 0o777).toBe(0o700)
      expect(statSync(join(dir(), files[0] as string)).mode & 0o777).toBe(0o600)
    }

    await forgetBase(VAULT, ID)
    expect(readdirSync(dir())).toHaveLength(0)
    expect(await loadBase(k, VAULT, ID, last)).toBeNull()
  })

  it('opens only for the last sync, vault and key it was saved for', async () => {
    const { loadBase, saveBase } = await load()
    const k = await key()
    await saveBase(k, VAULT, ID, last, bytes)
    expect(await loadBase(k, VAULT, ID, { ...last, version: 4 })).toBeNull()
    expect(await loadBase(k, VAULT, ID, { ...last, contentHash: 'b'.repeat(64) })).toBeNull()
    expect(await loadBase(k, VAULT, ID, null)).toBeNull()
    expect(await loadBase(k, VAULT, 'webapp', last)).toBeNull()
    expect(await loadBase(k, OTHER, ID, last)).toBeNull()
    expect(await loadBase(await key(), VAULT, ID, last)).toBeNull()
  })

  it('treats a tampered or unreadable base as none', async () => {
    const { loadBase, saveBase } = await load()
    const k = await key()
    await saveBase(k, VAULT, ID, last, bytes)
    const file = join(dir(), readdirSync(dir())[0] as string)
    writeFileSync(file, Buffer.from('not a base at all'))
    expect(await loadBase(k, VAULT, ID, last)).toBeNull()
    // Saved under a hash that doesn't match: never handed out.
    await saveBase(k, VAULT, ID, { ...last, contentHash: 'c'.repeat(64) }, bytes)
    expect(await loadBase(k, VAULT, ID, { ...last, contentHash: 'c'.repeat(64) })).toBeNull()
  })

  it('never writes outside the bases folder for a vault id that is not a UUID', async () => {
    const { loadBase, saveBase } = await load()
    const k = await key()
    await saveBase(k, '../escape', ID, last, bytes)
    expect(readdirSync(h.userData)).toEqual([])
    expect(await loadBase(k, '../escape', ID, last)).toBeNull()
  })
})
