// The vault: its policy, over a store that only moves bytes (store/types.ts).
//   meta.json      plaintext: format version, vaultId, KDF params, salt, keyCheck
//   <id>.env.enc   one encrypted entry per repo; <id> is the lowercased repo name
// Anything else in the store is ignored.
import { randomUUID } from 'node:crypto'
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
import { isValidRepoName } from '../core/paths'
import type { VaultFolderState, VaultLocation } from '../shared/types'
import { getConfig } from './config'
import { AppError } from './errors'
import { deriveKeyInWorker } from './kdf'
import { storeFor } from './store'
import { StoreConflictError, type StoreSnapshot, type VaultStore } from './store/types'

const META = 'meta.json'
const ENTRY_RE = /^([a-z0-9][a-z0-9._-]*)\.env\.enc$/
export const MIN_PASSWORD_CHARS = 12

/** The vault entry id for a repo: case-insensitive, like the filesystems. */
export const entryId = (repoName: string): string => repoName.toLowerCase()

const entryFile = (id: string): string => `${id}.env.enc`

export interface OpenedVault {
  key: Uint8Array
  vaultId: string
}

/**
 * The vault, with everything that touches it. Nothing outside this module
 * reads or writes the vault except through one of these.
 */
export interface Vault {
  state(): Promise<FolderState>
  create(password: string): Promise<OpenedVault>
  open(password: string): Promise<OpenedVault>
  /** A read view of the entries: take one per operation. */
  snapshot(): Promise<VaultSnapshot>
  /**
   * Replace one entry with already-encrypted bytes, if it is still at
   * `expected` (a version from a snapshot, or null for none); otherwise
   * VAULT_CHANGED. Returns the new version.
   */
  write(id: string, bytes: Uint8Array, expected: string | null): Promise<string>
}

export interface VaultSnapshot {
  /** Entry ids in the vault. */
  readonly ids: string[]
  /** Decrypt one entry, with the version to write against, or null if there is none. */
  read(key: Uint8Array, id: string): Promise<VaultEntry | null>
}

export interface VaultEntry {
  payload: Payload
  version: string
}

/** The vault kept in `store`. */
export function vaultOn(store: VaultStore): Vault {
  return {
    state: () => vaultState(store),
    create: (password) => createVault(store, password),
    open: (password) => openVault(store, password),
    snapshot: async () => entriesOf(await store.snapshot()),
    write: (id, bytes, expected) => writeEntry(store, id, bytes, expected)
  }
}

/** The vault at `location`. */
export function vaultFor(location: VaultLocation): Vault {
  return vaultOn(storeFor(location))
}

/** The vault in a folder. */
export function vaultAt(vaultPath: string): Vault {
  return vaultFor({ kind: 'folder', path: vaultPath })
}

/** The vault chosen in Settings, or null if none is chosen yet. */
export async function configuredVault(): Promise<Vault | null> {
  const { vault } = await getConfig()
  return vault ? vaultFor(vault) : null
}

/** The vault chosen in Settings, or NOT_CONFIGURED. */
export async function requireVault(): Promise<Vault> {
  const vault = await configuredVault()
  if (!vault) throw new AppError('NOT_CONFIGURED', 'Choose a vault folder first.')
  return vault
}

type FolderState = Exclude<VaultFolderState, 'not-configured'>

async function vaultState(store: VaultStore): Promise<FolderState> {
  if (!(await store.reachable())) return 'folder-missing'
  const { names } = await store.snapshot()
  if (names.includes(META)) return 'ready'
  return entryIds(names).length > 0 ? 'meta-missing' : 'empty'
}

function entryIds(names: string[]): string[] {
  const ids: string[] = []
  for (const name of names) {
    const id = ENTRY_RE.exec(name)?.[1]
    if (id && isValidRepoName(id)) ids.push(id)
  }
  return ids
}

async function requireFolder(store: VaultStore): Promise<FolderState> {
  const state = await vaultState(store)
  if (state === 'folder-missing') {
    throw new AppError(
      'VAULT_FOLDER_MISSING',
      'The vault folder was not found. Is Google Drive running?'
    )
  }
  return state
}

async function createVault(store: VaultStore, password: string): Promise<OpenedVault> {
  const state = await requireFolder(store)
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
  await store.check()
  const salt = await randomSalt()
  const vaultId = randomUUID()
  const kdf = { ...KDF_DEFAULTS }
  const key = await derive(password, salt, kdf)
  try {
    const meta = serializeMeta({ vaultId, kdf, salt, keyCheck: await makeKeyCheck(key, vaultId) })
    // Re-check right before writing: another machine may have created one
    // and Drive synced it in while we were deriving the key.
    if ((await vaultState(store)) !== 'empty') {
      throw new AppError('VAULT_EXISTS', 'A vault appeared in this folder; unlock it instead.')
    }
    // Written only if there is none: if a meta.json lands in the meantime it
    // wins, and we fail instead of orphaning its entries.
    try {
      await store.write(META, Buffer.from(JSON.stringify(meta, null, 2) + '\n', 'utf8'), null)
    } catch (err) {
      if (err instanceof StoreConflictError) {
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

async function openVault(store: VaultStore, password: string): Promise<OpenedVault> {
  await requireFolder(store)
  await store.check()
  const raw = (await (await store.snapshot()).get(META))?.bytes
  if (!raw) throw new AppError('VAULT_NOT_FOUND', 'No vault (meta.json) in this folder.')
  let meta
  try {
    meta = parseMeta(JSON.parse(Buffer.from(raw).toString('utf8')))
  } catch (err) {
    if (err instanceof MetaInvalidError) throw new AppError('META_INVALID', err.message)
    throw new AppError('META_INVALID', 'meta.json is not valid JSON.')
  }
  const key = await derive(password, meta.salt, meta.kdf)
  if (!(await verifyKeyCheck(key, meta.vaultId, meta.keyCheck))) {
    key.fill(0)
    throw new AppError('WRONG_PASSWORD', 'Wrong master password (or meta.json was modified).')
  }
  await store.cleanUp().catch(() => undefined)
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

function entriesOf(snapshot: StoreSnapshot): VaultSnapshot {
  return {
    ids: entryIds(snapshot.names),
    read: (key, id) => readEntry(snapshot, key, id)
  }
}

async function readEntry(
  snapshot: StoreSnapshot,
  key: Uint8Array,
  id: string
): Promise<VaultEntry | null> {
  const found = await snapshot.get(entryFile(id))
  if (!found) return null
  try {
    return { payload: await decryptPayload(key, id, found.bytes), version: found.version }
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

async function writeEntry(
  store: VaultStore,
  id: string,
  bytes: Uint8Array,
  expected: string | null
): Promise<string> {
  try {
    return await store.write(entryFile(id), bytes, expected)
  } catch (err) {
    if (err instanceof StoreConflictError) {
      throw new AppError(
        'VAULT_CHANGED',
        'The vault copy changed since you reviewed it. Review again.'
      )
    }
    throw err
  }
}
