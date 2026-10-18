// The vault folder (e.g. inside Google Drive):
//   meta.json            plaintext: format version, vaultId, KDF params, salt, keyCheck
//   <id>.env.enc         one encrypted entry per repo; <id> is the lowercased repo name
//   .<file>.<hex>.tmp    in-flight atomic writes (ours; cleaned up when stale)
// Anything else (Drive conflict copies, user files) is ignored.
import { randomUUID } from 'node:crypto'
import { readFile, readdir, rm, stat } from 'node:fs/promises'
import {
  KDF_DEFAULTS,
  MetaInvalidError,
  VaultTamperError,
  decryptPayload,
  makeKeyCheck,
  parseMeta,
  randomSalt,
  serializeMeta,
  verifyKeyCheck,
  type Payload
} from '../core/crypto'
import { isValidRepoName, resolveInside } from '../core/paths'
import type { VaultFolderState } from '../shared/types'
import { getConfig } from './config'
import { AppError } from './errors'
import { atomicWrite, isErrno, writeNew } from './fsutil'
import { deriveKeyInWorker } from './kdf'

const META = 'meta.json'
const ENTRY_RE = /^([a-z0-9][a-z0-9._-]*)\.env\.enc$/
const TEMP_RE = /^\.(?:meta\.json|[a-z0-9][a-z0-9._-]*\.env\.enc)\.[0-9a-f]{16}\.tmp$/
const STALE_TEMP_MS = 10 * 60_000
export const MIN_PASSWORD_CHARS = 12

/** The vault entry id for a repo: case-insensitive, like the filesystems. */
export const entryId = (repoName: string): string => repoName.toLowerCase()

const entryFile = (id: string): string => `${id}.env.enc`

export interface OpenedVault {
  key: Uint8Array
  vaultId: string
}

/**
 * The vault folder, with everything that touches it. Nothing outside this
 * module reads or writes the vault except through one of these.
 */
export interface Vault {
  state(): Promise<FolderState>
  create(password: string): Promise<OpenedVault>
  open(password: string): Promise<OpenedVault>
  /** Entry ids in the vault. */
  list(): Promise<string[]>
  /** Decrypt one entry, or null if the vault has none for this id. */
  read(key: Uint8Array, id: string): Promise<Payload | null>
  /** Replace one entry with already-encrypted bytes. */
  write(id: string, bytes: Uint8Array): Promise<void>
}

export function vaultAt(vaultPath: string): Vault {
  return {
    state: () => folderState(vaultPath),
    create: (password) => createVault(vaultPath, password),
    open: (password) => openVault(vaultPath, password),
    list: () => listEntryIds(vaultPath),
    read: (key, id) => readEntry(vaultPath, key, id),
    write: (id, bytes) => writeEntry(vaultPath, id, bytes)
  }
}

/** The vault chosen in Settings, or null if none is chosen yet. */
export async function configuredVault(): Promise<Vault | null> {
  const { vaultPath } = await getConfig()
  return vaultPath ? vaultAt(vaultPath) : null
}

/** The vault chosen in Settings, or NOT_CONFIGURED. */
export async function requireVault(): Promise<Vault> {
  const vault = await configuredVault()
  if (!vault) throw new AppError('NOT_CONFIGURED', 'Choose a vault folder first.')
  return vault
}

type FolderState = Exclude<VaultFolderState, 'not-configured'>

async function folderState(vaultPath: string): Promise<FolderState> {
  try {
    if (!(await stat(vaultPath)).isDirectory()) return 'folder-missing'
  } catch {
    return 'folder-missing'
  }
  try {
    await stat(resolveInside(vaultPath, META))
    return 'ready'
  } catch (err) {
    if (!isErrno(err, 'ENOENT')) throw err
  }
  return (await listEntryIds(vaultPath)).length > 0 ? 'meta-missing' : 'empty'
}

async function listEntryIds(vaultPath: string): Promise<string[]> {
  const ids: string[] = []
  for (const name of await readdir(vaultPath)) {
    const id = ENTRY_RE.exec(name)?.[1]
    if (id && isValidRepoName(id)) ids.push(id)
  }
  return ids
}

async function requireFolder(vaultPath: string): Promise<FolderState> {
  const state = await folderState(vaultPath)
  if (state === 'folder-missing') {
    throw new AppError(
      'VAULT_FOLDER_MISSING',
      'The vault folder was not found. Is Google Drive running?'
    )
  }
  return state
}

async function createVault(vaultPath: string, password: string): Promise<OpenedVault> {
  const state = await requireFolder(vaultPath)
  if (state === 'ready') throw new AppError('VAULT_EXISTS', 'This folder already contains a vault.')
  if (state === 'meta-missing') {
    throw new AppError(
      'VAULT_META_MISSING',
      "Vault files exist but meta.json is missing. Wait for Drive to finish syncing, or restore meta.json from Drive's trash or version history."
    )
  }
  if ([...password].length < MIN_PASSWORD_CHARS) {
    throw new AppError('PASSWORD_TOO_SHORT', `Use at least ${MIN_PASSWORD_CHARS} characters.`)
  }
  const salt = await randomSalt()
  const vaultId = randomUUID()
  const kdf = { ...KDF_DEFAULTS }
  const key = await derive(password, salt, kdf)
  try {
    const meta = serializeMeta({ vaultId, kdf, salt, keyCheck: await makeKeyCheck(key, vaultId) })
    // Re-check right before writing: another machine may have created one
    // and Drive synced it in while we were deriving the key.
    if ((await folderState(vaultPath)) !== 'empty') {
      throw new AppError('VAULT_EXISTS', 'A vault appeared in this folder; unlock it instead.')
    }
    // Exclusive create, never rename-over: if a meta.json lands in the
    // meantime it wins, and we fail instead of orphaning its entries.
    try {
      await writeNew(vaultPath, META, JSON.stringify(meta, null, 2) + '\n', 0o644)
    } catch (err) {
      if (isErrno(err, 'EEXIST')) {
        throw new AppError('VAULT_EXISTS', 'A vault appeared in this folder; unlock it instead.')
      }
      throw err
    }
    return { key, vaultId }
  } catch (err) {
    key.fill(0)
    throw err
  }
}

async function openVault(vaultPath: string, password: string): Promise<OpenedVault> {
  await requireFolder(vaultPath)
  let raw: string
  try {
    raw = await readFile(resolveInside(vaultPath, META), 'utf8')
  } catch (err) {
    if (isErrno(err, 'ENOENT'))
      throw new AppError('VAULT_NOT_FOUND', 'No vault (meta.json) in this folder.')
    throw err
  }
  let meta
  try {
    meta = parseMeta(JSON.parse(raw))
  } catch (err) {
    if (err instanceof MetaInvalidError) throw new AppError('META_INVALID', err.message)
    throw new AppError('META_INVALID', 'meta.json is not valid JSON.')
  }
  const key = await derive(password, meta.salt, meta.kdf)
  if (!(await verifyKeyCheck(key, meta.vaultId, meta.keyCheck))) {
    key.fill(0)
    throw new AppError('WRONG_PASSWORD', 'Wrong master password (or meta.json was modified).')
  }
  await cleanupStaleTemp(vaultPath).catch(() => undefined)
  return { key, vaultId: meta.vaultId }
}

async function derive(
  password: string,
  salt: Uint8Array,
  kdf: { opslimit: number; memlimit: number }
): Promise<Uint8Array> {
  try {
    return await deriveKeyInWorker({ password, salt, kdf })
  } catch (err) {
    throw new AppError('KDF_FAILED', err instanceof Error ? err.message : 'Key derivation failed.')
  }
}

async function readEntry(vaultPath: string, key: Uint8Array, id: string): Promise<Payload | null> {
  let bytes: Buffer
  try {
    bytes = await readFile(resolveInside(vaultPath, entryFile(id)))
  } catch (err) {
    if (isErrno(err, 'ENOENT')) return null
    throw err
  }
  try {
    return await decryptPayload(key, id, bytes)
  } catch (err) {
    if (err instanceof VaultTamperError) {
      throw new AppError(
        'VAULT_TAMPERED',
        `The vault copy of "${id}" failed verification (corrupted, tampered with, or from a different vault). ${err.message}`
      )
    }
    throw err
  }
}

async function writeEntry(vaultPath: string, id: string, bytes: Uint8Array): Promise<void> {
  // atomicWrite's default temp name (".<file>.<16 hex>.tmp", matched by
  // TEMP_RE) has a random suffix, so two machines' in-flight temp files
  // (which Drive may sync) never collide.
  await atomicWrite(vaultPath, entryFile(id), bytes, { mode: 0o644 })
}

/** Remove our own temp files left by a crash. Recent ones may be in flight. */
async function cleanupStaleTemp(vaultPath: string): Promise<void> {
  const now = Date.now()
  for (const name of await readdir(vaultPath)) {
    if (!TEMP_RE.test(name)) continue
    const file = resolveInside(vaultPath, name)
    const info = await stat(file)
    if (now - info.mtimeMs > STALE_TEMP_MS) await rm(file, { force: true })
  }
}
