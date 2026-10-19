// The vault: its policy, over a store that only moves bytes (store/types.ts).
//   meta.json      plaintext: format version, vaultId, KDF params, salt,
//                  (format 2) secretId, keyCheck
//   <id>.env.enc   one encrypted entry per repo; <id> is the lowercased repo name
// Anything else in the store is ignored.
//
// A format 2 vault's key also needs its secret, which is never in the vault:
// each machine keeps it (secrets.ts), and gets it once as a setup code.
import { randomUUID } from 'node:crypto'
import {
  KDF_DEFAULTS,
  MetaInvalidError,
  VaultTamperError,
  decryptPayload,
  makeKeyCheck,
  parseMeta,
  randomSalt,
  randomSecret,
  secretIdOf,
  secretMatches,
  serializeMeta,
  vaultKey,
  verifyKeyCheck,
  type Meta,
  type Payload
} from '../core/crypto'
import { passwordProblem } from '../core/password'
import { isValidRepoName } from '../core/paths'
import { formatSetupCode, parseSetupCode, SetupCodeError } from '../core/setupcode'
import type { SetupCodeState, VaultFolderState, VaultLocation } from '../shared/types'
import { getConfig } from './config'
import { AppError } from './errors'
import { deriveKeyInWorker } from './kdf'
import { machineSecrets, type VaultSecrets } from './secrets'
import { storeFor } from './store'
import { StoreConflictError, type StoreSnapshot, type VaultStore } from './store/types'

const META = 'meta.json'
const ENTRY_RE = /^([a-z0-9][a-z0-9._-]*)\.env\.enc$/
export const MIN_PASSWORD_CHARS = 12

/** A file that belongs in a vault: meta.json or an entry. */
export const isVaultFile = (name: string): boolean => name === META || ENTRY_RE.test(name)

/** The vault entry id for a repo: case-insensitive, like the filesystems. */
export const entryId = (repoName: string): string => repoName.toLowerCase()

const entryFile = (id: string): string => `${id}.env.enc`

export interface OpenedVault {
  key: Uint8Array
  vaultId: string
}

export interface CreatedVault extends OpenedVault {
  /** Format 2: the setup code, to show once. Format 1: null. */
  setupCode: string | null
}

/**
 * The vault, with everything that touches it. Nothing outside this module
 * reads or writes the vault except through one of these.
 */
export interface Vault {
  state(): Promise<FolderState>
  /**
   * Create a vault. With `setupCode` (always, in a git repository) it's
   * format 2: its secret is kept on this machine and returned as a setup code.
   */
  create(password: string, opts?: { setupCode?: boolean }): Promise<CreatedVault>
  /** Unlock it. A format 2 vault uses this machine's secret, or `setupCode` if given. */
  open(password: string, setupCode?: string): Promise<OpenedVault>
  /** Whether this machine can open it without a setup code. Reads meta.json, no network checks. */
  setupCodeState(): Promise<SetupCodeState>
  /** This machine's setup code for the vault, once the password proves right. */
  showSetupCode(password: string): Promise<string>
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

/** The vault kept in `store`, with this machine's secrets in `secrets`. */
export function vaultOn(store: VaultStore, secrets: VaultSecrets = machineSecrets): Vault {
  return {
    state: () => vaultState(store),
    create: (password, opts) => createVault(store, secrets, password, opts?.setupCode ?? false),
    open: (password, setupCode) => openVault(store, secrets, password, setupCode),
    setupCodeState: () => setupCodeState(store, secrets),
    showSetupCode: (password) => showSetupCode(store, secrets, password),
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
  if (!vault) throw new AppError('NOT_CONFIGURED', 'Choose a vault first.')
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

/** What the vault is in, for messages. */
const place = (store: VaultStore): string => (store.kind === 'git' ? 'repository' : 'folder')

async function requireFolder(store: VaultStore): Promise<FolderState> {
  const state = await vaultState(store)
  if (state !== 'folder-missing') return state
  if (store.kind === 'git') {
    // Asking again gives git's own reason (no network, no access).
    await store.check()
    throw new AppError(
      'GIT_VAULT_UNREACHABLE',
      "Couldn't reach the vault repository. Check your network and your git access to it."
    )
  }
  throw new AppError(
    'VAULT_FOLDER_MISSING',
    'The vault folder was not found. Is Google Drive running?'
  )
}

async function createVault(
  store: VaultStore,
  secrets: VaultSecrets,
  password: string,
  withSetupCode: boolean
): Promise<CreatedVault> {
  const state = await requireFolder(store)
  if (state === 'ready') {
    throw new AppError('VAULT_EXISTS', `This ${place(store)} already contains a vault.`)
  }
  if (state === 'meta-missing') {
    throw new AppError(
      'VAULT_META_MISSING',
      store.kind === 'git'
        ? "Vault files exist but meta.json is missing. Restore it from the repository's history."
        : "Vault files exist but meta.json is missing. Wait for Drive to finish syncing, or restore meta.json from Drive's trash or version history."
    )
  }
  if ([...password].length < MIN_PASSWORD_CHARS) {
    throw new AppError('PASSWORD_TOO_SHORT', `Use at least ${MIN_PASSWORD_CHARS} characters.`)
  }
  const weak = await passwordProblem(password, await passwordContext())
  if (weak) throw new AppError('PASSWORD_WEAK', weak)
  await store.check()
  const salt = await randomSalt()
  const vaultId = randomUUID()
  const kdf = { ...KDF_DEFAULTS }
  // A git repository is always format 2: anyone who can read it, now or in
  // its history, could otherwise guess the password offline.
  const secret = withSetupCode || store.kind === 'git' ? await randomSecret() : null
  try {
    const key = combine(await derive(password, salt, kdf), secret, vaultId)
    let saved = false
    try {
      const meta = serializeMeta({
        vaultId,
        kdf,
        salt,
        secretId: secret ? secretIdOf(secret, vaultId) : null,
        keyCheck: await makeKeyCheck(key, vaultId)
      })
      // Re-check right before writing: another machine may have created one
      // (and Drive synced it in) while we were deriving the key.
      const appeared = (): AppError =>
        new AppError('VAULT_EXISTS', `A vault appeared in this ${place(store)}; unlock it instead.`)
      if ((await vaultState(store)) !== 'empty') throw appeared()
      // Kept on this machine before meta.json exists: a vault whose secret no
      // machine has could never be opened.
      if (secret) {
        await secrets.save(vaultId, secret)
        saved = true
      }
      // Written only if there is none: if a meta.json lands in the meantime it
      // wins, and we fail instead of orphaning its entries.
      try {
        await store.write(META, Buffer.from(JSON.stringify(meta, null, 2) + '\n', 'utf8'), null)
      } catch (err) {
        if (err instanceof StoreConflictError) throw appeared()
        throw err
      }
      return { key, vaultId, setupCode: secret ? formatSetupCode(secret) : null }
    } catch (err) {
      key.fill(0)
      if (saved) await secrets.forget(vaultId).catch(() => undefined)
      throw err
    }
  } finally {
    secret?.fill(0)
  }
}

/** Words an attacker would try first: the app's name, this machine's, and the folders' and repository's. */
async function passwordContext(): Promise<string[]> {
  const cfg = await getConfig()
  const where = cfg.vault?.kind === 'git' ? cfg.vault.url : cfg.vault?.path
  const words = [cfg.machineName, cfg.projectsPath, where].flatMap(
    (s) => s?.split(/[^\p{L}\p{N}]+/u) ?? []
  )
  return ['envvault', cfg.machineName, ...words].filter((w) => w.length >= 3)
}

async function openVault(
  store: VaultStore,
  secrets: VaultSecrets,
  password: string,
  setupCode: string | undefined
): Promise<OpenedVault> {
  await requireFolder(store)
  await store.check()
  const meta = await readMeta(store)
  const secret = meta.secretId ? await secretFor(meta, secrets, setupCode) : null
  try {
    const key = await checkedKey(meta, password, secret)
    // A typed setup code is kept only once the password has proved it right.
    if (secret && setupCode !== undefined) {
      try {
        await secrets.save(meta.vaultId, secret)
      } catch (err) {
        key.fill(0)
        throw err
      }
    }
    await store.cleanUp().catch(() => undefined)
    return { key, vaultId: meta.vaultId }
  } finally {
    secret?.fill(0)
  }
}

async function setupCodeState(store: VaultStore, secrets: VaultSecrets): Promise<SetupCodeState> {
  const meta = await readMeta(store)
  if (!meta.secretId) return 'not-used'
  const stored = await secrets.load(meta.vaultId)
  const saved = stored !== null && secretMatches(meta, stored)
  stored?.fill(0)
  return saved ? 'saved' : 'needed'
}

async function showSetupCode(
  store: VaultStore,
  secrets: VaultSecrets,
  password: string
): Promise<string> {
  const meta = await readMeta(store)
  if (!meta.secretId) throw new AppError('NO_SETUP_CODE', "This vault doesn't use a setup code.")
  const secret = await secretFor(meta, secrets, undefined)
  try {
    ;(await checkedKey(meta, password, secret)).fill(0)
    return formatSetupCode(secret)
  } finally {
    secret.fill(0)
  }
}

async function readMeta(store: VaultStore): Promise<Meta> {
  const raw = (await (await store.snapshot()).get(META))?.bytes
  if (!raw) throw new AppError('VAULT_NOT_FOUND', `No vault (meta.json) in this ${place(store)}.`)
  try {
    return parseMeta(JSON.parse(Buffer.from(raw).toString('utf8')))
  } catch (err) {
    if (err instanceof MetaInvalidError) throw new AppError('META_INVALID', err.message)
    throw new AppError('META_INVALID', 'meta.json is not valid JSON.')
  }
}

/** A format 2 vault's secret: from a typed setup code, or this machine's. The caller wipes it. */
async function secretFor(
  meta: Meta,
  secrets: VaultSecrets,
  setupCode: string | undefined
): Promise<Uint8Array> {
  if (setupCode !== undefined) {
    let secret: Uint8Array
    try {
      secret = parseSetupCode(setupCode)
    } catch (err) {
      if (err instanceof SetupCodeError) throw new AppError('SETUP_CODE_INVALID', err.message)
      throw err
    }
    if (!secretMatches(meta, secret)) {
      secret.fill(0)
      throw new AppError('SETUP_CODE_WRONG', 'This setup code is for a different vault.')
    }
    return secret
  }
  const stored = await secrets.load(meta.vaultId)
  if (stored && secretMatches(meta, stored)) return stored
  stored?.fill(0)
  throw new AppError(
    'SETUP_CODE_REQUIRED',
    'This vault needs its setup code on this machine. Enter it with your master password.'
  )
}

/** The vault key from `password` (and the secret, for format 2), or WRONG_PASSWORD. */
async function checkedKey(
  meta: Meta,
  password: string,
  secret: Uint8Array | null
): Promise<Uint8Array> {
  const key = combine(await derive(password, meta.salt, meta.kdf), secret, meta.vaultId)
  if (!(await verifyKeyCheck(key, meta.vaultId, meta.keyCheck))) {
    key.fill(0)
    throw new AppError('WRONG_PASSWORD', 'Wrong master password (or meta.json was modified).')
  }
  return key
}

/** Format 2's key from the Argon2id output and the secret (wiping the output); format 1's is the output. */
function combine(derived: Uint8Array, secret: Uint8Array | null, vaultId: string): Uint8Array {
  if (!secret) return derived
  try {
    return vaultKey(derived, secret, vaultId)
  } finally {
    derived.fill(0)
  }
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
