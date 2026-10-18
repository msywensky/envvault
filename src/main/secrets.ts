// Format 2 vault secrets on this machine (see vaultKey in core/crypto.ts),
// keyed by vault id. Never in the vault and never logged. On disk they're
// encrypted with Electron's safeStorage (the Keychain on macOS, DPAPI on
// Windows), so a powered-off machine doesn't give them up without its OS
// login:
//   <userData>/vault-secrets.json   { "<vaultId>": "<safeStorage blob, base64>" }
import { app, safeStorage } from 'electron'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { SECRET_BYTES } from '../core/crypto'
import { AppError } from './errors'
import { atomicWrite, isErrno } from './fsutil'
import { createSerial } from './mutex'

const FILE = 'vault-secrets.json'
const FileSchema = z.record(z.uuid(), z.base64())

/** Where a format 2 vault's secret is kept. vault.ts takes one (tests pass MemorySecrets). */
export interface VaultSecrets {
  /** The secret, or null if this machine has none (or can't read it). */
  load(vaultId: string): Promise<Uint8Array | null>
  save(vaultId: string, secret: Uint8Array): Promise<void>
  forget(vaultId: string): Promise<void>
}

// Read-modify-write of the file must not interleave.
const serial = createSerial()

function requireSafeStorage(): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new AppError(
      'SECRET_STORE_UNAVAILABLE',
      "This computer's secure storage isn't available, so EnvVault can't keep the vault's setup code."
    )
  }
}

/** The file's entries. A missing or unreadable file has none. */
async function readAll(): Promise<Record<string, string>> {
  let raw: string
  try {
    raw = await readFile(join(app.getPath('userData'), FILE), 'utf8')
  } catch (err) {
    if (isErrno(err, 'ENOENT')) return {}
    throw err
  }
  try {
    const parsed = FileSchema.safeParse(JSON.parse(raw))
    if (parsed.success) return parsed.data
  } catch {
    // Reported below.
  }
  console.error(`[envvault] ${FILE} unreadable; setup codes will be asked for again`)
  return {}
}

async function writeAll(entries: Record<string, string>): Promise<void> {
  await atomicWrite(app.getPath('userData'), FILE, JSON.stringify(entries, null, 2), {
    mode: 0o600
  })
}

export const machineSecrets: VaultSecrets = {
  async load(vaultId) {
    requireSafeStorage()
    const blob = (await readAll())[vaultId]
    if (!blob) return null
    let encoded: string
    try {
      encoded = safeStorage.decryptString(Buffer.from(blob, 'base64'))
    } catch {
      // Encrypted by another user or a reset keychain: ask for the code again.
      return null
    }
    const secret = new Uint8Array(Buffer.from(encoded, 'base64'))
    return secret.length === SECRET_BYTES ? secret : null
  },

  save(vaultId, secret) {
    return serial(async () => {
      requireSafeStorage()
      const blob = safeStorage.encryptString(Buffer.from(secret).toString('base64'))
      await writeAll({ ...(await readAll()), [vaultId]: blob.toString('base64') })
    })
  },

  forget(vaultId) {
    return serial(async () => {
      const entries = await readAll()
      if (!(vaultId in entries)) return
      delete entries[vaultId]
      await writeAll(entries)
    })
  }
}

/** Secrets in memory: one "machine" in tests. */
export class MemorySecrets implements VaultSecrets {
  private readonly secrets = new Map<string, Uint8Array>()

  async load(vaultId: string): Promise<Uint8Array | null> {
    return this.secrets.get(vaultId)?.slice() ?? null
  }

  async save(vaultId: string, secret: Uint8Array): Promise<void> {
    this.secrets.set(vaultId, secret.slice())
  }

  async forget(vaultId: string): Promise<void> {
    this.secrets.delete(vaultId)
  }
}
