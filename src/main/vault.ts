// The vault: its policy, over a store that only moves bytes (store/types.ts).
//   meta.json              plaintext: format version, vaultId, KDF params, salt,
//                          (format 2) secretId, keyCheck
//   <repo>.env.enc         a repo's own .env; <repo> is the lowercased repo name
//   <repo>.<tag>.file.enc  an env file elsewhere in that repo; the tag names its
//                          path (see fileTagger), which is kept in the ciphertext
//   settings.enc           repo settings for every machine (core/vaultsettings)
// Anything else in the store is ignored.
//
// A format 2 vault's key also needs its secret, which is never in the vault:
// each machine keeps it (secrets.ts), and gets it once as a setup code.
import { randomUUID } from 'node:crypto'
import {
  KDF_DEFAULTS,
  MetaInvalidError,
  VaultTamperError,
  decryptFilePayload,
  decryptPayload,
  decryptSettings,
  encryptFilePayload,
  encryptPayload,
  encryptSettings,
  fileTagger,
  makeKeyCheck,
  parseMeta,
  randomSalt,
  randomSecret,
  secretIdOf,
  secretMatches,
  serializeMeta,
  vaultKey,
  verifyKeyCheck,
  type FileTagger,
  type Meta,
  type Payload
} from '../core/crypto'
import { ROOT_ENV, envPathId, isEnvPath } from '../core/envpath'
import { passwordProblem } from '../core/password'
import { isValidRepoName } from '../core/paths'
import { formatSetupCode, parseSetupCode, SetupCodeError } from '../core/setupcode'
import {
  MAX_SETTINGS_BYTES,
  SettingsError,
  emptySettings,
  parseSettings,
  settingsTooLarge,
  type VaultSettings
} from '../core/vaultsettings'
import type { EnvFile, SetupCodeState, VaultFolderState, VaultLocation } from '../shared/types'
import { getConfig } from './config'
import { AppError } from './errors'
import { deriveKeyInWorker } from './kdf'
import { machineSecrets, type VaultSecrets } from './secrets'
import { storeFor } from './store'
import { StoreConflictError, type StoreSnapshot, type VaultStore } from './store/types'

const META = 'meta.json'
// Never an entry's name: those end in .env.enc or .file.enc.
const SETTINGS = 'settings.enc'
// The suffixes never overlap, so a name is one kind or the other: a repo
// called "web.0123456789abcdef" still has the root entry "….env.enc".
const ENTRY_RE = /^([a-z0-9][a-z0-9._-]*)\.env\.enc$/
const FILE_ENTRY_RE = /^([a-z0-9][a-z0-9._-]*)\.([0-9a-f]{16})\.file\.enc$/
export const MIN_PASSWORD_CHARS = 12

/** A file that belongs in a vault: meta.json, the settings or an entry. */
export const isVaultFile = (name: string): boolean =>
  name === META || name === SETTINGS || ENTRY_RE.test(name) || FILE_ENTRY_RE.test(name)

/** The vault entry id for a repo: case-insensitive, like the filesystems. */
export const entryId = (repoName: string): string => repoName.toLowerCase()

/**
 * One entry: a repo's root .env, or an env file elsewhere in it, named by a
 * tag of its path. A file entry's path is known only once it is decrypted.
 */
export type EntryRef =
  { kind: 'root'; repoId: string } | { kind: 'file'; repoId: string; tag: string }

/** The entry's name in the store, also shown to the user to find it there. */
export const entryName = (ref: EntryRef): string =>
  ref.kind === 'root' ? `${ref.repoId}.env.enc` : `${ref.repoId}.${ref.tag}.file.enc`

/**
 * The entry's key in state.json. A root entry's is its repo id, as before
 * file entries existed; "/" can't appear in a repo id, so they never collide.
 */
export const stateKey = (ref: EntryRef): string =>
  ref.kind === 'root' ? ref.repoId : `${ref.repoId}/${ref.tag}`

/** What entries are read and named with: the vault key, and a tagger from it. */
export interface EntryKeys {
  readonly key: Uint8Array
  readonly tagger: FileTagger
}

/** Run `fn` with `key` and a file tagger derived from it, which is wiped afterwards. */
export async function withEntryKeys<T>(
  key: Uint8Array,
  fn: (keys: EntryKeys) => Promise<T>
): Promise<T> {
  const tagger = fileTagger(key)
  try {
    return await fn({ key, tagger })
  } finally {
    tagger.wipe()
  }
}

/** The entry for an env file. */
export function entryFor(keys: EntryKeys, file: EnvFile): EntryRef {
  if (!isValidRepoName(file.repoName) || !isEnvPath(file.path)) {
    throw new Error('Not an env file.')
  }
  const repoId = entryId(file.repoName)
  return file.path === ROOT_ENV
    ? { kind: 'root', repoId }
    : { kind: 'file', repoId, tag: keys.tagger.tag(repoId, envPathId(file.path)) }
}

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
   * Encrypt `payload` as `file`'s entry and write it, if the entry is still
   * at `expected` (a version from a snapshot, or null for none); otherwise
   * VAULT_CHANGED. Returns the new version.
   */
  write(keys: EntryKeys, file: EnvFile, payload: Payload, expected: string | null): Promise<string>
  /** Remove one entry if it is still at `expected`, otherwise VAULT_CHANGED. */
  remove(ref: EntryRef, expected: string): Promise<void>
  /**
   * Encrypt and write the repo settings, if they are still at `expected` (a
   * version from SettingsRead, or null for none); otherwise VAULT_CHANGED.
   */
  writeSettings(keys: EntryKeys, settings: VaultSettings, expected: string | null): Promise<string>
}

export interface VaultSnapshot {
  /** The entries in the vault. */
  readonly entries: EntryRef[]
  /** Decrypt one entry, with the version to write against, or null if there is none. */
  read(keys: EntryKeys, ref: EntryRef): Promise<VaultEntry | null>
  /** The repo settings. Never fails with an AppError: see SettingsRead.error. */
  settings(keys: EntryKeys): Promise<SettingsRead>
}

export interface SettingsRead {
  /** The settings in force: the vault's, or the built-in ones if it has none or they can't be read. */
  settings: VaultSettings
  /** settings.enc's version, to write against: null if there is none. */
  version: string | null
  /** Why settings.enc couldn't be read (VAULT_TAMPERED, VAULT_NEEDS_UPDATE), or null. */
  error: AppError | null
}

export interface VaultEntry {
  payload: Payload
  /** The env file's path in its repo: ROOT_ENV for a root entry. */
  path: string
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
    write: (keys, file, payload, expected) => writeEntry(store, keys, file, payload, expected),
    remove: (ref, expected) => removeEntry(store, ref, expected),
    writeSettings: (keys, settings, expected) => writeSettings(store, keys, settings, expected)
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
  return entryRefs(names).length > 0 || names.includes(SETTINGS) ? 'meta-missing' : 'empty'
}

function entryRefs(names: string[]): EntryRef[] {
  const refs: EntryRef[] = []
  for (const name of names) {
    const root = ENTRY_RE.exec(name)
    const file = FILE_ENTRY_RE.exec(name)
    if (root?.[1] && isValidRepoName(root[1])) refs.push({ kind: 'root', repoId: root[1] })
    else if (file?.[1] && file[2] && isValidRepoName(file[1])) {
      refs.push({ kind: 'file', repoId: file[1], tag: file[2] })
    }
  }
  return refs
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
    entries: entryRefs(snapshot.names),
    read: (keys, ref) => readEntry(snapshot, keys, ref),
    settings: (keys) => readSettings(snapshot, keys)
  }
}

async function readEntry(
  snapshot: StoreSnapshot,
  keys: EntryKeys,
  ref: EntryRef
): Promise<VaultEntry | null> {
  const found = await snapshot.get(entryName(ref))
  if (!found) return null
  try {
    if (ref.kind === 'root') {
      const payload = await decryptPayload(keys.key, ref.repoId, found.bytes)
      return { payload, path: ROOT_ENV, version: found.version }
    }
    const { path, ...payload } = await decryptFilePayload(
      keys.key,
      ref.repoId,
      ref.tag,
      found.bytes
    )
    // Only someone with the key could write a mismatch, but the path decides
    // where a pull writes: it must be what the name says, and never the root
    // .env, which has its own entry.
    if (path === ROOT_ENV || keys.tagger.tag(ref.repoId, envPathId(path)) !== ref.tag) {
      throw new VaultTamperError("The file's path doesn't match its name.")
    }
    // Written with the key, for a file this version doesn't sync.
    if (!isEnvPath(path)) {
      throw new AppError(
        'VAULT_NEEDS_UPDATE',
        `The vault copy of an env file in "${ref.repoId}" (${entryName(ref)}) was saved by a newer EnvVault. Update this one to use it.`
      )
    }
    return { payload, path, version: found.version }
  } catch (err) {
    if (err instanceof VaultTamperError) {
      const what =
        ref.kind === 'root'
          ? `"${ref.repoId}"`
          : `an env file in "${ref.repoId}" (${entryName(ref)})`
      throw new AppError(
        'VAULT_TAMPERED',
        `The vault copy of ${what} failed verification (corrupted, tampered with, or from a different vault). ${err.message}`
      )
    }
    throw err
  }
}

async function writeEntry(
  store: VaultStore,
  keys: EntryKeys,
  file: EnvFile,
  payload: Payload,
  expected: string | null
): Promise<string> {
  const ref = entryFor(keys, file)
  const bytes =
    ref.kind === 'root'
      ? await encryptPayload(keys.key, ref.repoId, payload)
      : await encryptFilePayload(keys.key, ref.repoId, ref.tag, { ...payload, path: file.path })
  try {
    return await store.write(entryName(ref), bytes, expected)
  } catch (err) {
    if (err instanceof StoreConflictError) throw vaultChanged()
    throw err
  }
}

async function removeEntry(store: VaultStore, ref: EntryRef, expected: string): Promise<void> {
  try {
    await store.delete(entryName(ref), expected)
  } catch (err) {
    if (err instanceof StoreConflictError) throw vaultChanged()
    throw err
  }
}

const vaultChanged = (): AppError =>
  new AppError('VAULT_CHANGED', 'The vault copy changed since you reviewed it. Review again.')

// What the built-in settings mean, for the messages below.
const BUILT_IN_MEANS = 'Until then every .env syncs, and no repo is ignored.'

async function readSettings(snapshot: StoreSnapshot, keys: EntryKeys): Promise<SettingsRead> {
  const found = await snapshot.get(SETTINGS)
  if (!found) return { settings: emptySettings(), version: null, error: null }
  const failed = (error: AppError): SettingsRead => ({
    settings: emptySettings(),
    version: found.version,
    error
  })
  const tampered = (): SettingsRead =>
    failed(
      new AppError(
        'VAULT_TAMPERED',
        `The repo settings in the vault failed verification (corrupted, tampered with, or from a different vault). Reset them to start again. ${BUILT_IN_MEANS}`
      )
    )
  // Room for the ciphertext's header and tag.
  if (found.bytes.length > MAX_SETTINGS_BYTES + 1024) return tampered()
  try {
    return {
      settings: parseSettings(await decryptSettings(keys.key, found.bytes)),
      version: found.version,
      error: null
    }
  } catch (err) {
    if (err instanceof SettingsError && err.newer) {
      return failed(
        new AppError(
          'VAULT_NEEDS_UPDATE',
          `The repo settings in the vault were saved by a newer EnvVault. Update this one to use them. ${BUILT_IN_MEANS}`
        )
      )
    }
    if (err instanceof SettingsError || err instanceof VaultTamperError) return tampered()
    throw err
  }
}

async function writeSettings(
  store: VaultStore,
  keys: EntryKeys,
  settings: VaultSettings,
  expected: string | null
): Promise<string> {
  if (settingsTooLarge(settings)) {
    throw new AppError('BAD_REQUEST', 'The repo settings would be too large to save.')
  }
  const bytes = await encryptSettings(keys.key, settings)
  try {
    return await store.write(SETTINGS, bytes, expected)
  } catch (err) {
    if (err instanceof StoreConflictError) {
      throw new AppError('VAULT_CHANGED', 'The repo settings changed on another machine.')
    }
    throw err
  }
}
