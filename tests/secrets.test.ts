// This machine's vault secrets (src/main/secrets.ts), with Electron's
// safeStorage replaced by a reversible stand-in.
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ userData: '', available: true }))

vi.mock('electron', () => ({
  app: { getPath: () => h.userData },
  safeStorage: {
    isEncryptionAvailable: () => h.available,
    encryptString: (text: string) => Buffer.from(`sealed:${text}`),
    decryptString: (blob: Buffer) => {
      const text = blob.toString()
      if (!text.startsWith('sealed:')) throw new Error('not ours')
      return text.slice('sealed:'.length)
    }
  }
}))

const root = mkdtempSync(join(tmpdir(), 'envvault-secrets-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const VAULT = '3f1c2b8e-5d4a-4c3b-9a2e-1f0e9d8c7b6a'
const OTHER = '9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d'
const secret = (fill: number): Uint8Array => new Uint8Array(16).fill(fill)
const hex = (b: Uint8Array | null): string | null => (b ? Buffer.from(b).toString('hex') : null)
const file = (): string => join(h.userData, 'vault-secrets.json')

let n = 0
beforeEach(() => {
  h.userData = mkdtempSync(join(root, `u${n++}-`))
  h.available = true
  vi.resetModules()
})

const load = async (): Promise<typeof import('../src/main/secrets')> =>
  import('../src/main/secrets')

describe('machine secrets', () => {
  it('saves, loads and forgets, per vault', async () => {
    const { machineSecrets } = await load()
    expect(await machineSecrets.load(VAULT)).toBeNull()
    await machineSecrets.save(VAULT, secret(1))
    await machineSecrets.save(OTHER, secret(2))
    expect(hex(await machineSecrets.load(VAULT))).toBe(hex(secret(1)))
    expect(hex(await machineSecrets.load(OTHER))).toBe(hex(secret(2)))
    await machineSecrets.forget(VAULT)
    expect(await machineSecrets.load(VAULT)).toBeNull()
    expect(hex(await machineSecrets.load(OTHER))).toBe(hex(secret(2)))
  })

  it('keeps only sealed blobs on disk, readable by you alone', async () => {
    const { machineSecrets } = await load()
    await machineSecrets.save(VAULT, secret(9))
    const raw = readFileSync(file(), 'utf8')
    expect(raw).not.toContain(Buffer.from(secret(9)).toString('base64'))
    const blob = (JSON.parse(raw) as Record<string, string>)[VAULT] ?? ''
    expect(Buffer.from(blob, 'base64').toString()).toMatch(/^sealed:/)
    if (process.platform !== 'win32') expect(statSync(file()).mode & 0o777).toBe(0o600)
  })

  it('asks again rather than failing when the file or a blob is unreadable', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const { machineSecrets } = await load()
      writeFileSync(file(), '{not json')
      expect(await machineSecrets.load(VAULT)).toBeNull()
      writeFileSync(file(), JSON.stringify({ [VAULT]: Buffer.from('foreign').toString('base64') }))
      expect(await machineSecrets.load(VAULT)).toBeNull()
      writeFileSync(
        file(),
        JSON.stringify({ [VAULT]: Buffer.from('sealed:AAAA').toString('base64') })
      )
      expect(await machineSecrets.load(VAULT)).toBeNull()
      // A broken file is replaced by the next save.
      writeFileSync(file(), '{not json')
      await machineSecrets.save(VAULT, secret(3))
      expect(hex(await machineSecrets.load(VAULT))).toBe(hex(secret(3)))
    } finally {
      quiet.mockRestore()
    }
  })

  it('refuses without secure storage', async () => {
    h.available = false
    const { machineSecrets } = await load()
    await expect(machineSecrets.save(VAULT, secret(1))).rejects.toMatchObject({
      code: 'SECRET_STORE_UNAVAILABLE'
    })
    await expect(machineSecrets.load(VAULT)).rejects.toMatchObject({
      code: 'SECRET_STORE_UNAVAILABLE'
    })
  })
})
