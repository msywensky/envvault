// Push / pull flows, one env file at a time: a repo's root .env, or one in a
// folder inside it (see core/envpath). Every function takes a private copy
// of the key (see session.withKey) and returns metadata and key names only,
// never values, except pullRawDiff, which the user asks for explicitly.
// Serialisation (one write at a time) is done by the IPC handlers.
// Machine-specific keys (# envvault:local, see core/localkeys) are blanked in
// what a push uploads and status hashes, and kept from the local file by a
// pull.
import { lstat, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { decodeEnv, makePayload, sha256Hex, type Payload } from '../core/crypto'
import { diffKeys, parseEnv } from '../core/envdiff'
import {
  ROOT_ENV,
  backupName,
  envFileName,
  envFolders,
  envPathId,
  isBackupOf
} from '../core/envpath'
import { applyEdits, DuplicateKeyError, EditError, editorEntries } from '../core/envedit'
import { compareExample } from '../core/example'
import { lineDiff } from '../core/linediff'
import { markedKeys, unmarkedKeys } from '../core/localkeys'
import { computeStatus, needsOverwriteConfirm, nextVersion } from '../core/status'
import {
  allRepoRules,
  effectiveRules,
  emptySettings,
  repoRules,
  sameFileRules,
  sameRepoRules,
  withDefaults,
  withRepo,
  type VaultSettings
} from '../core/vaultsettings'
import { isIncluded, type FileRules } from '../shared/envrules'
import type {
  EditorData,
  EnvFile,
  ExampleCheck,
  Expected,
  GitignoreResult,
  PullPreview,
  PullRequest,
  PullResult,
  PushPreview,
  PushRequest,
  RawDiff,
  RawDiffRequest,
  RemoveRequest,
  RepoInfo,
  RepoList,
  RepoRow,
  RepoSettingsRequest,
  SaveEditRequest,
  SaveEditResult,
  Settings,
  VaultInfo,
  VaultNameRequest
} from '../shared/types'
import { MAX_REPO_NAMES, getConfig, updateConfig } from './config'
import { AppError, errnoCode } from './errors'
import { atomicWrite, isErrno, randomHex, writeNew } from './fsutil'
import { addToGitignore, checkIgnored, ignoreStatus, isTracked } from './git'
import { mergedBytes, syncedBytes } from './localkeys'
import {
  MAX_ENV_BYTES,
  envFilesIn,
  listFolders,
  repoAt,
  readEnvFile,
  readRepoFile,
  resolveEnvDir,
  resolveRepo,
  scanEnvFile,
  scanRepos,
  type ScannedFile,
  type ScannedRepo
} from './repos'
import { getLast, setLast } from './state'
import {
  entryFor,
  entryId,
  entryName,
  stateKey,
  vaultFor,
  withEntryKeys,
  type EntryKeys,
  type EntryRef,
  type SettingsRead,
  type Vault,
  type VaultEntry,
  type VaultSnapshot
} from './vault'

// The vault is reached only through `vault` (see vault.ts), never by location.
type Configured = Omit<Settings, 'vault'> & { projectsPath: string; vault: Vault }

async function configured(): Promise<Configured> {
  const { vault, ...cfg } = await getConfig()
  if (!cfg.projectsPath || !vault) {
    throw new AppError('NOT_CONFIGURED', 'Choose a projects folder and a vault first.')
  }
  return { ...cfg, projectsPath: cfg.projectsPath, vault: vaultFor(vault) }
}

function toInfo(p: Payload): VaultInfo {
  return {
    version: p.version,
    contentHash: p.contentHash,
    updatedBy: p.updatedBy,
    updatedAt: p.updatedAt
  }
}

/** Parse .env bytes for diffing, then wipe the bytes. */
function parseAndWipe(bytes: Buffer | null): Map<string, string> {
  if (!bytes) return new Map()
  try {
    return parseEnv(bytes.toString('utf8'))
  } finally {
    bytes.fill(0)
  }
}

/** Just the file, from a request that names one. */
const fileOf = (req: EnvFile): EnvFile => ({ repoName: req.repoName, path: req.path })

/**
 * The name this machine's folder `folder` syncs as in the vault: its own,
 * unless Settings.repoNames says otherwise.
 */
function vaultNameOf(cfg: Pick<Settings, 'repoNames'>, folder: string): string {
  const id = entryId(folder)
  return Object.hasOwn(cfg.repoNames, id) ? (cfg.repoNames[id] ?? folder) : folder
}

/**
 * An entry's key in state.json for this machine's folder `folder` (null: a
 * repo only in the vault). A folder syncing under its own name uses the
 * entry's own key, as before folders could sync as another name; one syncing
 * as another gets its own, so two checkouts of one repo each keep their last
 * sync. A repo id can't contain "@".
 */
function lastKey(ref: EntryRef, folder: string | null): string {
  const id = folder === null ? ref.repoId : entryId(folder)
  return id === ref.repoId ? stateKey(ref) : `${stateKey(ref)}@${id}`
}

/** REPO_IGNORED or ENV_EXCLUDED unless the repo's settings sync `stored` (a vault-side file). */
function requireSynced(settings: VaultSettings, stored: EnvFile, label: string): void {
  const id = entryId(stored.repoName)
  if (repoRules(settings, id).ignored) {
    throw new AppError(
      'REPO_IGNORED',
      `${label} is ignored in EnvVault. Stop ignoring it in its settings first.`
    )
  }
  if (!isIncluded(stored.path, effectiveRules(settings, id))) {
    throw new AppError('ENV_EXCLUDED', `${stored.path} is excluded by ${label}'s settings.`)
  }
}

// ---------------------------------------------------------------------------

export interface ListOptions {
  /**
   * Only this repo: the folder of that name, or else the repo of that name
   * that is only in the vault. Nothing if there is neither.
   */
  only?: string
  /** Ask git again which env files each repo has (see scanRepos). */
  find?: boolean
}

/** A vault entry as the list sees it: read, or the error reading it gave. */
interface Listed {
  ref: EntryRef
  /** The file's path: known for a root entry, and for a file entry once it is read. */
  path: string | null
  entry: VaultEntry | null
  error: AppError | null
}

/** A repo as the list sees it: a folder (`dir`), or only in the vault (`dir` null). */
interface Listing {
  name: string
  dir: string | null
  vaultName: string
  /** entryId(vaultName). */
  vaultId: string
}

/**
 * Every repo, and a row per env file of those that aren't ignored, sorted by
 * repo with each root .env first. A repo is a folder in the projects folder,
 * whose files sync under its vault name, or a vault name no folder syncs as.
 */
export async function listRepos(
  key: Uint8Array,
  vaultId: string,
  opts: ListOptions = {}
): Promise<RepoList> {
  const cfg = await configured()
  // One snapshot for every row, so the list is one consistent view of the vault.
  const [folders, snapshot] = await Promise.all([
    listFolders(cfg.projectsPath),
    cfg.vault.snapshot()
  ])
  return withEntryKeys(key, async (keys) => {
    const read = await snapshot.settings(keys)
    const { settings } = read

    // Two folders differing only by case map to one repo id; keep the first.
    const seen = new Set<string>()
    const locals: (Listing & { dir: string })[] = []
    for (const f of folders) {
      if (seen.has(entryId(f.name))) continue
      seen.add(entryId(f.name))
      const vaultName = vaultNameOf(cfg, f.name)
      locals.push({ name: f.name, dir: f.dir, vaultName, vaultId: entryId(vaultName) })
    }
    const claimed = new Set(locals.map((l) => l.vaultId))
    const unclaimed = [...new Set(snapshot.entries.map((ref) => ref.repoId))].filter(
      (id) => !claimed.has(id)
    )
    const onlyId = opts.only === undefined ? null : entryId(opts.only)
    const repos: Listing[] = [
      ...locals.filter((l) => onlyId === null || entryId(l.name) === onlyId),
      ...unclaimed
        .filter((id) => onlyId === null || (id === onlyId && !seen.has(onlyId)))
        .map((id) => ({ name: id, dir: null, vaultName: id, vaultId: id }))
    ]
    const ignored = (r: Listing): boolean => repoRules(settings, r.vaultId).ignored

    const synced = repos.filter((r) => !ignored(r))
    const scanned = await scanRepos(
      synced.flatMap((r) => (r.dir === null ? [] : [{ name: r.name, dir: r.dir }])),
      {
        find: opts.find,
        rulesFor: (f) => effectiveRules(settings, entryId(vaultNameOf(cfg, f.name)))
      }
    )
    const scanOf = new Map(scanned.map((s) => [s.dir, s]))

    // Every entry is read for its status anyway, which is also how a file
    // entry's path is learnt. Once per vault name, however many folders sync
    // as it; never for an ignored repo.
    const listedFor = new Map<string, Promise<Listed[]>>()
    const listedOf = (id: string): Promise<Listed[]> => {
      let listed = listedFor.get(id)
      if (!listed) {
        listed = Promise.all(
          snapshot.entries
            .filter((ref) => ref.repoId === id)
            .map((ref) => listEntry(snapshot, keys, ref))
        )
        listedFor.set(id, listed)
      }
      return listed
    }
    const rows = await Promise.all(
      synced.map(async (r) =>
        repoRows(
          keys,
          vaultId,
          r,
          r.dir === null ? null : (scanOf.get(r.dir) ?? null),
          await listedOf(r.vaultId),
          effectiveRules(settings, r.vaultId)
        )
      )
    )
    return {
      rows: rows.flat().sort(byFile),
      repos: repos.map((r): RepoInfo => ({
        name: r.name,
        local: r.dir !== null,
        vaultName: r.vaultName,
        ignored: ignored(r),
        found: r.dir === null ? null : (scanOf.get(r.dir)?.found ?? null),
        copies: snapshot.entries.filter((ref) => ref.repoId === r.vaultId).length
      })),
      settings: settingsView(read)
    }
  })
}

function settingsView(read: SettingsRead): RepoList['settings'] {
  return {
    defaults: {
      include: [...read.settings.defaults.include],
      exclude: [...read.settings.defaults.exclude]
    },
    repos: allRepoRules(read.settings),
    error: read.error ? { code: read.error.code, message: read.error.message } : null
  }
}

async function listEntry(snapshot: VaultSnapshot, keys: EntryKeys, ref: EntryRef): Promise<Listed> {
  const known = ref.kind === 'root' ? ROOT_ENV : null
  try {
    const entry = await snapshot.read(keys, ref)
    return { ref, path: entry?.path ?? known, entry, error: null }
  } catch (err) {
    if (!(err instanceof AppError)) throw err
    return { ref, path: known, entry: null, error: err }
  }
}

interface FileState {
  path: string
  scan: ScannedFile | null
  listed: Listed | null
}

/**
 * One repo's rows: each env file its rules include that it has or the vault
 * has a copy of, and its root .env if the rules include it and it exists on
 * either side or there is nothing else (so the repo is listed, and Edit can
 * start its vault copy). Vault copies the rules exclude are listed as such,
 * to be removed. `scan` is null for a repo that is only in the vault.
 */
async function repoRows(
  keys: EntryKeys,
  vaultId: string,
  repo: Listing,
  scan: ScannedRepo | null,
  listed: Listed[],
  rules: FileRules
): Promise<RepoRow[]> {
  const { name, vaultName } = repo
  const local = repo.dir !== null
  const files = new Map<string, FileState>()
  for (const s of scan?.files ?? []) {
    const id = envPathId(s.path)
    if (!files.has(id)) files.set(id, { path: s.path, scan: s, listed: null })
  }
  const unreadable: Listed[] = []
  const excluded: Listed[] = []
  for (const l of listed) {
    // A file entry that couldn't be read has no path to go by. (One that
    // vanished since the snapshot was taken has neither entry nor error.)
    if (l.path === null) {
      if (l.error) unreadable.push(l)
      continue
    }
    if (!isIncluded(l.path, rules)) {
      if (l.entry || l.error) excluded.push(l)
      continue
    }
    const file = files.get(envPathId(l.path))
    if (file) file.listed = l
    else files.set(envPathId(l.path), { path: l.path, scan: null, listed: l })
  }
  // Vault copies of files git didn't report (or wasn't asked about this time).
  if (scan) {
    await Promise.all(
      [...files.values()]
        .filter((f) => f.scan === null)
        .map(async (f) => {
          f.scan = await scanEnvFile(scan.dir, f.path)
        })
    )
  }

  const inVault = (f: FileState): boolean =>
    f.listed !== null && (f.listed.entry !== null || f.listed.error !== null)
  const hasLocal = (f: FileState): boolean =>
    f.scan !== null && (f.scan.localHash !== null || f.scan.envError !== null)
  const others = [...files.values()].filter(
    (f) =>
      f.path !== ROOT_ENV &&
      (inVault(f) ||
        // A symlinked .env in a folder usually points at the root one.
        (hasLocal(f) && f.scan?.envError?.code !== 'ENV_SYMLINK'))
  )
  const root = files.get(envPathId(ROOT_ENV))
  const nothingElse = others.length === 0 && unreadable.length === 0 && excluded.length === 0
  const showRoot = root !== undefined && (inVault(root) || hasLocal(root) || nothingElse)

  const base = { name, local, vaultName }
  const errorInfo = (err: AppError | null): RepoRow['error'] =>
    err ? { code: err.code, message: err.message } : null

  const row = async (f: FileState): Promise<RepoRow> => {
    const ref = f.listed?.ref ?? entryFor(keys, { repoName: vaultName, path: f.path })
    const key = lastKey(ref, local ? name : null)
    const fields = {
      ...base,
      path: f.path,
      storedName: inVault(f) ? entryName(ref) : null,
      hasEnv: hasLocal(f)
    }
    try {
      if (f.scan?.envError) throw f.scan.envError
      if (f.listed?.error) throw f.listed.error
      const vault = f.listed?.entry ? toInfo(f.listed.entry.payload) : null
      const last = await getLast(vaultId, key)
      const status = computeStatus({
        repoExists: local && (f.scan?.folderExists ?? false),
        localHash: f.scan?.localHash ?? null,
        vault,
        last
      })
      // Identical content synced some other way (copied by hand, pushed from
      // an identical file elsewhere): adopt it, so the next push needs no
      // overwrite confirmation. (setLast serialises its own writes.)
      if (
        status === 'in-sync' &&
        vault &&
        (last?.version !== vault.version || last.contentHash !== vault.contentHash)
      ) {
        await setLast(vaultId, key, { version: vault.version, contentHash: vault.contentHash })
      }
      return { ...fields, status, vault, error: null }
    } catch (err) {
      if (!(err instanceof AppError)) throw err
      return { ...fields, status: 'error', vault: null, error: errorInfo(err) }
    }
  }

  const rows = await Promise.all([...(showRoot ? [root] : []), ...others].map(row))
  return [
    ...rows,
    // Not read locally, never pushed or pulled: only there to be removed.
    ...excluded.map((l): RepoRow => ({
      ...base,
      path: l.path,
      storedName: entryName(l.ref),
      status: l.error ? 'error' : 'excluded',
      hasEnv: false,
      vault: l.entry ? toInfo(l.entry.payload) : null,
      error: errorInfo(l.error)
    })),
    ...unreadable.map((l): RepoRow => ({
      ...base,
      path: null,
      storedName: entryName(l.ref),
      status: 'error',
      hasEnv: false,
      vault: null,
      error: errorInfo(l.error)
    }))
  ]
}

const fileRank = (row: RepoRow): number => (row.path === ROOT_ENV ? 0 : row.path === null ? 2 : 1)

function byFile(a: RepoRow, b: RepoRow): number {
  return (
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) ||
    // A folder before a repo of the same name that is only in the vault.
    Number(b.local) - Number(a.local) ||
    fileRank(a) - fileRank(b) ||
    (a.path ?? a.storedName ?? '').localeCompare(b.path ?? b.storedName ?? '')
  )
}

// ---------------------------------------------------------------------------

interface Snapshot {
  cfg: Configured
  keys: EntryKeys
  /** The file in this machine's folder. */
  file: EnvFile
  /** The same file in the vault: under the name the folder syncs as. */
  stored: EnvFile
  ref: EntryRef
  repoDir: string
  /** The file's folder, or null if it doesn't exist (see resolveEnvDir). */
  envDir: string | null
  /** The entry's key in state.json. */
  id: string
  /** Plaintext local .env. The caller must wipe it (see withSnapshot). */
  local: Buffer | null
  /** sha256 of the raw local bytes, so `expected` notices any edit. */
  localHash: string | null
  /** What a push uploads: syncedBytes(local), wiped like `local`. */
  synced: Buffer | null
  /** sha256 of `synced`, which is what status compares with the vault. */
  syncedHash: string | null
  payload: Payload | null
  vault: VaultInfo | null
  /** The vault entry's storage version, which a push writes against (null: none). */
  vaultVersion: string | null
}

/** The vault-side file for `file`, in this machine's folder. */
const storedFile = (cfg: Configured, file: EnvFile): EnvFile => ({
  repoName: vaultNameOf(cfg, file.repoName),
  path: file.path
})

/**
 * Read the current local and vault state of one env file, run `fn`, then
 * wipe the plaintext. REPO_IGNORED or ENV_EXCLUDED if the repo's settings
 * don't sync it.
 */
async function withSnapshot<T>(
  key: Uint8Array,
  req: EnvFile,
  fn: (s: Snapshot) => Promise<T>
): Promise<T> {
  const file = fileOf(req)
  const cfg = await configured()
  const repoDir = await resolveRepo(cfg.projectsPath, file.repoName)
  const envDir = await resolveEnvDir(repoDir, file.path)
  const stored = storedFile(cfg, file)
  return withEntryKeys(key, async (keys) => {
    const snapshot = await cfg.vault.snapshot()
    requireSynced((await snapshot.settings(keys)).settings, stored, file.repoName)
    const ref = entryFor(keys, stored)
    const local = envDir ? await readEnvFile(envDir, file.path) : null
    let synced: Buffer | null = null
    try {
      synced = local ? syncedBytes(local) : null
      const entry = await snapshot.read(keys, ref)
      const payload = entry?.payload ?? null
      return await fn({
        cfg,
        keys,
        file,
        stored,
        ref,
        repoDir,
        envDir,
        id: lastKey(ref, file.repoName),
        local,
        localHash: local ? sha256Hex(local) : null,
        synced,
        syncedHash: synced ? sha256Hex(synced) : null,
        payload,
        vault: payload ? toInfo(payload) : null,
        vaultVersion: entry?.version ?? null
      })
    } finally {
      if (synced !== local) synced?.fill(0)
      local?.fill(0)
    }
  })
}

function checkExpected(s: Snapshot, expected: Expected): void {
  if (s.localHash !== expected.localHash) {
    throw new AppError(
      'LOCAL_CHANGED',
      'The local .env changed since you reviewed it. Review again.'
    )
  }
  if ((s.vault?.contentHash ?? null) !== expected.vaultHash) {
    throw new AppError(
      'VAULT_CHANGED',
      'The vault copy changed since you reviewed it. Review again.'
    )
  }
}

const expectedOf = (s: Snapshot): Expected => ({
  localHash: s.localHash,
  vaultHash: s.vault?.contentHash ?? null
})

/** The row of a file that is now in sync with `vault`. */
const syncedRow = (s: Snapshot, vault: VaultInfo): RepoRow => ({
  name: s.file.repoName,
  local: true,
  vaultName: s.stored.repoName,
  path: s.file.path,
  storedName: entryName(s.ref),
  status: 'in-sync',
  hasEnv: true,
  vault,
  error: null
})

const EXAMPLE = '.env.example'

/** The .env.example check applies to files named .env only, not to .env.local and the like. */
const checksExample = (s: Snapshot): boolean =>
  s.cfg.checkExample && envFileName(s.file.path) === ROOT_ENV

/**
 * How `env` compares with the .env.example next to it (in `envDir`), or null
 * if there is none. Advisory only: a file that can't be read is reported,
 * never thrown.
 */
async function checkExample(
  envDir: string,
  env: Map<string, string>
): Promise<ExampleCheck | null> {
  let bytes: Buffer | null
  try {
    bytes = await readRepoFile(envDir, EXAMPLE)
  } catch (err) {
    // Node's own messages contain paths, so only ours are passed on.
    const message = err instanceof AppError ? err.message : `${EXAMPLE} could not be read.`
    return { status: 'unreadable', message }
  }
  if (!bytes) return null
  const diff = compareExample(env, parseAndWipe(bytes))
  // Only needed to word the same-value warning; push previews work without git.
  const tracked =
    diff.sameValue.length > 0 ? await isTracked(envDir, EXAMPLE).catch(() => null) : null
  return { status: 'ok', tracked, ...diff }
}

const noLocalEnv = (): AppError => new AppError('ENV_NOT_FOUND', 'This repo has no .env to push.')
const noVaultCopy = (): AppError =>
  new AppError('VAULT_ENTRY_NOT_FOUND', 'The vault has no copy of this repo.')

/** The file's folder, or ENV_FOLDER_MISSING: a pull writes into a folder, never creates one. */
function folderFor(s: Snapshot): string {
  if (s.envDir) return s.envDir
  throw new AppError(
    'ENV_FOLDER_MISSING',
    `${envFolders(s.file.path).join('/')} isn't in this copy of ${s.file.repoName}, so there is nowhere to pull its .env to.`
  )
}

export function previewPush(key: Uint8Array, vaultId: string, file: EnvFile): Promise<PushPreview> {
  return withSnapshot(key, file, async (s) => {
    if (!s.local || !s.synced || !s.envDir) throw noLocalEnv()
    const last = await getLast(vaultId, s.id)
    // The raw file: machine-specific values don't belong in the example either.
    const example = checksExample(s)
      ? await checkExample(s.envDir, parseAndWipe(Buffer.from(s.local)))
      : null
    const vaultBytes = s.payload ? decodeEnv(s.payload) : null
    const localText = s.local.toString('utf8')
    const vaultText = vaultBytes?.toString('utf8') ?? null
    return {
      diff: diffKeys(parseAndWipe(Buffer.from(s.synced)), parseAndWipe(vaultBytes)),
      needsOverwrite: needsOverwriteConfirm(s.vault, last),
      vault: s.vault,
      sameContent: s.syncedHash === s.vault?.contentHash,
      kept: markedKeys(localText),
      unmarked: unmarkedKeys(localText, vaultText),
      example,
      expected: expectedOf(s)
    }
  })
}

export function push(key: Uint8Array, vaultId: string, req: PushRequest): Promise<RepoRow> {
  return withSnapshot(key, req, async (s) => {
    if (!s.synced || !s.syncedHash) throw noLocalEnv()
    checkExpected(s, req.expected)
    const last = await getLast(vaultId, s.id)
    if (needsOverwriteConfirm(s.vault, last) && !req.overwriteConfirmed) {
      throw new AppError(
        'OVERWRITE_NOT_CONFIRMED',
        'The vault copy was changed elsewhere. Confirm the overwrite to continue.'
      )
    }
    let vault = s.vault
    if (!vault || vault.contentHash !== s.syncedHash) {
      const payload = makePayload(s.synced, nextVersion(vault, last), s.cfg.machineName)
      // `expected` above is what the user reviewed; the version makes the
      // write itself fail if the vault copy changed after this snapshot.
      await s.cfg.vault.write(s.keys, s.stored, payload, s.vaultVersion)
      vault = toInfo(payload)
    }
    await setLast(vaultId, s.id, { version: vault.version, contentHash: vault.contentHash })
    return syncedRow(s, vault)
  })
}

// ---------------------------------------------------------------------------

export function previewPull(key: Uint8Array, vaultId: string, file: EnvFile): Promise<PullPreview> {
  return withSnapshot(key, file, async (s) => {
    if (!s.payload || !s.vault) throw noVaultCopy()
    const envDir = folderFor(s)
    const [last, git] = await Promise.all([
      getLast(vaultId, s.id),
      ignoreStatus(envDir, envFileName(s.file.path))
    ])
    const merged = mergedBytes(decodeEnv(s.payload), s.local)
    const mergedHash = sha256Hex(merged.bytes)
    // Both compare what the pull writes, so kept keys don't show as changed.
    const mergedEnv = parseAndWipe(merged.bytes)
    const example = checksExample(s) ? await checkExample(envDir, mergedEnv) : null
    return {
      diff: diffKeys(mergedEnv, parseAndWipe(s.local ? Buffer.from(s.local) : null)),
      vault: s.vault,
      hasLocal: s.local !== null,
      ...git,
      rollback: last !== null && s.vault.version < last.version,
      sameContent: mergedHash === s.localHash,
      kept: merged.kept,
      unset: merged.unset,
      example,
      expected: expectedOf(s)
    }
  })
}

/**
 * The lines a pull would change, with their values masked unless
 * `req.values` is set: then this is the one place env values leave the main
 * process. Only for the content the user reviewed, and only changed lines
 * plus a little context (see lineDiff).
 */
export function pullRawDiff(key: Uint8Array, req: RawDiffRequest): Promise<RawDiff> {
  return withSnapshot(key, req, async (s) => {
    if (!s.payload || !s.vault) throw noVaultCopy()
    folderFor(s)
    checkExpected(s, req.expected)
    const { bytes } = mergedBytes(decodeEnv(s.payload), s.local)
    try {
      const lines = lineDiff(s.local?.toString('utf8') ?? '', bytes.toString('utf8'), {
        mask: !req.values
      })
      return { lines }
    } finally {
      bytes.fill(0)
    }
  })
}

/** Windows-safe UTC timestamp, e.g. 20261016T153045Z. */
export function backupStamp(now: Date): string {
  return now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z')
}

export function pull(key: Uint8Array, vaultId: string, req: PullRequest): Promise<PullResult> {
  return withSnapshot(key, req, async (s) => {
    if (!s.payload || !s.vault) throw noVaultCopy()
    const envDir = folderFor(s)
    checkExpected(s, req.expected)
    const name = envFileName(s.file.path)
    const [tracked, ignored] = await Promise.all([
      isTracked(envDir, name),
      checkIgnored(envDir, name)
    ])
    if (tracked) {
      throw new AppError(
        'ENV_TRACKED',
        `${s.file.path} is committed to git. Run \`git rm --cached ${s.file.path}\`, commit, then retry.`
      )
    }
    if (!ignored) {
      throw new AppError('ENV_NOT_IGNORED', `${s.file.path} is not in .gitignore. Add it first.`)
    }

    return { backupName: await applyPull(s, envDir, s.payload, s.vault, vaultId) }
  })
}

/**
 * Pull without review when the change is one-sided: the vault copy is newer
 * and the local .env is unchanged since this machine's last sync (or
 * missing), and git would ignore what a pull writes. Anything else
 * (conflict, rollback, git not set up, its folder missing) is left for the
 * user. Returns the updated row, or null if it didn't pull.
 */
export function autoPull(key: Uint8Array, vaultId: string, file: EnvFile): Promise<RepoRow | null> {
  return withSnapshot(key, file, async (s) => {
    if (!s.payload || !s.vault || !s.envDir) return null
    const last = await getLast(vaultId, s.id)
    const status = computeStatus({
      repoExists: true,
      localHash: s.syncedHash,
      vault: s.vault,
      last
    })
    if (status !== 'vault-newer') return null
    const git = await ignoreStatus(s.envDir, envFileName(s.file.path))
    if (!git.ignored || !git.backupIgnored || git.tracked) return null
    await applyPull(s, s.envDir, s.payload, s.vault, vaultId)
    return syncedRow(s, s.vault)
  })
}

/**
 * Write the vault copy, merged with this machine's machine-specific lines,
 * over the local .env in `envDir` (backing it up first) and record the sync.
 * The caller has checked that the .env is git-ignored and untracked. Returns
 * the backup's name, or null if there was nothing to back up or nothing
 * changed.
 */
async function applyPull(
  s: Snapshot,
  envDir: string,
  payload: Payload,
  vault: VaultInfo,
  vaultId: string
): Promise<string | null> {
  let backup: string | null = null
  const fileName = envFileName(s.file.path)
  const bytes = mergedBytes(decodeEnv(payload), s.local).bytes
  try {
    if (sha256Hex(bytes) !== s.localHash) {
      // The temp file holds plaintext, so it is named to match .env.bak.*
      // and checked like the backup: a crash must never leave secrets in an
      // un-ignored file.
      const tmpName = `.env.bak.tmp-${randomHex(8)}`
      const wantBackup =
        s.local && s.cfg.backups ? backupName(fileName, backupStamp(new Date())) : null
      for (const name of [tmpName, wantBackup]) {
        if (name && !(await checkIgnored(envDir, name))) {
          throw new AppError(
            'BACKUP_NOT_IGNORED',
            `${name} would not be ignored by git. Add ".env.bak.*" to .gitignore.`
          )
        }
      }
      if (s.local && wantBackup) backup = await writeBackup(envDir, wantBackup, s.local)
      await atomicWrite(envDir, fileName, bytes, { tmpName, mode: 0o600 })
      // Only once the file is written: a failed pull never costs an older backup.
      if (backup) await pruneBackups(envDir, fileName, s.cfg.backupCount)
    }
  } finally {
    bytes.fill(0)
  }
  await setLast(vaultId, s.id, { version: vault.version, contentHash: vault.contentHash })
  return backup
}

/**
 * Write the bytes we already read and checked (never re-read .env, which
 * could have become a symlink) to a new backup file. Returns the name used.
 */
async function writeBackup(dir: string, name: string, bytes: Buffer): Promise<string> {
  for (const candidate of [name, `${name}-${randomHex(2)}`]) {
    try {
      await writeNew(dir, candidate, bytes, 0o600)
      return candidate
    } catch (err) {
      if (!isErrno(err, 'EEXIST')) throw err
    }
  }
  throw new AppError('FS_ERROR', 'Could not create a unique backup file name.')
}

/**
 * Delete all but the newest `keep` backups of the env file `fileName` in
 * `dir` (the names sort by time). Only writeBackup's names (see isBackupOf):
 * never the pull's temp file, another env file's backups or anyone else's.
 * Best effort: the pull has succeeded, and what can't be deleted now is tried
 * again after the next backup.
 */
async function pruneBackups(dir: string, fileName: string, keep: number): Promise<void> {
  let names: string[]
  try {
    names = (await readdir(dir)).filter((name) => isBackupOf(fileName, name)).sort()
  } catch (err) {
    console.error(`[envvault] listing backups failed: ${errnoCode(err) ?? 'unknown'}`)
    return
  }
  for (const name of names.slice(0, Math.max(0, names.length - keep))) {
    const file = join(dir, name)
    try {
      // A regular file only: never a symlink or a folder that happens to match.
      if ((await lstat(file)).isFile()) await rm(file)
    } catch (err) {
      console.error(`[envvault] removing an old backup failed: ${errnoCode(err) ?? 'unknown'}`)
    }
  }
}

// ---------------------------------------------------------------------------
// Editing the vault copy. Like pullRawDiff, these carry env values: openEditor
// sends them to the editor, saveEdit receives the changed ones back.

/** The vault copy as text, or '' if there is none. Refuses bytes that aren't UTF-8. */
function editableText(payload: Payload | null): string {
  if (!payload) return ''
  const bytes = decodeEnv(payload)
  let again: Buffer | null = null
  try {
    const text = bytes.toString('utf8')
    again = Buffer.from(text, 'utf8')
    if (!again.equals(bytes)) {
      throw new AppError(
        'ENV_NOT_UTF8',
        "The vault copy isn't valid UTF-8, so it can't be edited here."
      )
    }
    return text
  } finally {
    bytes.fill(0)
    again?.fill(0)
  }
}

function editing<T>(fn: () => T): T {
  try {
    return fn()
  } catch (err) {
    if (err instanceof DuplicateKeyError) {
      throw new AppError(
        'ENV_DUPLICATE_KEY',
        "A key is assigned more than once in the vault copy, so it can't be edited here. Fix it in a .env and push it."
      )
    }
    // EditError messages are fixed strings that never contain keys or values.
    if (err instanceof EditError) throw new AppError('EDIT_INVALID', err.message)
    throw err
  }
}

const editorStale = (): AppError =>
  new AppError(
    'VAULT_CHANGED',
    'The vault copy changed since you opened the editor. Reload it and make your changes again.'
  )

/** The repo must be in the projects folder, with the file's folder in it. */
async function requireFolder(cfg: Configured, file: EnvFile): Promise<string> {
  const envDir = await resolveEnvDir(await resolveRepo(cfg.projectsPath, file.repoName), file.path)
  if (envDir) return envDir
  throw new AppError(
    'ENV_FOLDER_MISSING',
    `${envFolders(file.path).join('/')} isn't in this copy of ${file.repoName}.`
  )
}

/**
 * A snapshot of the vault for a file the repo's settings sync (see
 * requireSynced), with the file's entry.
 */
async function syncedEntry(
  cfg: Configured,
  keys: EntryKeys,
  file: EnvFile
): Promise<{ stored: EnvFile; ref: EntryRef; entry: VaultEntry | null }> {
  const stored = storedFile(cfg, file)
  const snapshot = await cfg.vault.snapshot()
  requireSynced((await snapshot.settings(keys)).settings, stored, file.repoName)
  const ref = entryFor(keys, stored)
  return { stored, ref, entry: await snapshot.read(keys, ref) }
}

/** The vault copy of an env file in the projects folder, as editor rows. */
export async function openEditor(key: Uint8Array, req: EnvFile): Promise<EditorData> {
  const file = fileOf(req)
  const cfg = await configured()
  await requireFolder(cfg, file)
  const { entry } = await withEntryKeys(key, (keys) => syncedEntry(cfg, keys, file))
  const payload = entry?.payload ?? null
  const entries = editing(() => editorEntries(editableText(payload)))
  return {
    entries,
    vault: payload ? toInfo(payload) : null,
    expectedVaultHash: payload?.contentHash ?? null
  }
}

/**
 * Apply the editor's changes to the vault copy as a new version, if it is
 * still the one the editor opened. Leaves the local .env and this machine's
 * last sync alone, so a local .env shows as vault-newer and is pulled as usual.
 */
export async function saveEdit(
  key: Uint8Array,
  vaultId: string,
  req: SaveEditRequest
): Promise<SaveEditResult> {
  const file = fileOf(req)
  const cfg = await configured()
  await requireFolder(cfg, file)
  return withEntryKeys(key, async (keys) => {
    const { stored, ref, entry } = await syncedEntry(cfg, keys, file)
    const payload = entry?.payload ?? null
    const vault = payload ? toInfo(payload) : null
    if ((vault?.contentHash ?? null) !== req.expectedVaultHash) throw editorStale()
    const edited = Buffer.from(
      editing(() => applyEdits(editableText(payload), req)),
      'utf8'
    )
    let synced: Buffer | null = null
    try {
      if (edited.length > MAX_ENV_BYTES) {
        throw new AppError('ENV_TOO_LARGE', 'The edited .env would be larger than 1 MiB.')
      }
      // Keeps machine-specific keys canonical, as a push would.
      synced = syncedBytes(edited)
      const unchanged = vault ? sha256Hex(synced) === vault.contentHash : synced.length === 0
      if (unchanged) return { vault, changed: false }
      const next = makePayload(
        synced,
        nextVersion(vault, await getLast(vaultId, lastKey(ref, file.repoName))),
        cfg.machineName
      )
      try {
        await cfg.vault.write(keys, stored, next, entry?.version ?? null)
      } catch (err) {
        if (err instanceof AppError && err.code === 'VAULT_CHANGED') throw editorStale()
        throw err
      }
      return { vault: toInfo(next), changed: true }
    } finally {
      if (synced !== edited) synced?.fill(0)
      edited.fill(0)
    }
  })
}

// ---------------------------------------------------------------------------

/**
 * Delete an env file's vault copy, by its vault name, if it is still the one
 * the user saw. The repo doesn't need to be in the projects folder (a Vault
 * only row), and no local file is touched, here or on any other machine. A
 * copy the repo's rules exclude can be removed; an ignored repo's can't. The
 * copy must decrypt; a broken one shows its stored name, to be deleted by
 * hand.
 */
export async function removeFromVault(
  key: Uint8Array,
  vaultId: string,
  req: RemoveRequest
): Promise<null> {
  const stored = { repoName: req.vaultName, path: req.path }
  const cfg = await configured()
  return withEntryKeys(key, async (keys) => {
    const snapshot = await cfg.vault.snapshot()
    const { settings } = await snapshot.settings(keys)
    if (repoRules(settings, entryId(stored.repoName)).ignored) {
      throw new AppError(
        'REPO_IGNORED',
        `${stored.repoName} is ignored in EnvVault. Stop ignoring it in its settings first.`
      )
    }
    const ref = entryFor(keys, stored)
    const entry = await snapshot.read(keys, ref)
    if (!entry) throw noVaultCopy()
    if (entry.payload.contentHash !== req.expectedVaultHash) {
      throw new AppError(
        'VAULT_CHANGED',
        'The vault copy changed since you looked at it. Check it again before removing it.'
      )
    }
    await cfg.vault.remove(ref, entry.version)
    // A floor for the file's versions on this machine, for every folder that
    // syncs it: pushed again from here, it continues above the removed copy,
    // so a machine that synced that copy doesn't take the new one for a
    // rollback.
    const folders = Object.entries(cfg.repoNames)
      .filter(([, name]) => entryId(name) === ref.repoId)
      .map(([folder]) => folder)
    for (const id of [stateKey(ref), ...folders.map((f) => lastKey(ref, f))]) {
      const last = await getLast(vaultId, id)
      if (!last || last.version < entry.payload.version) {
        await setLast(vaultId, id, {
          version: entry.payload.version,
          contentHash: entry.payload.contentHash
        })
      }
    }
    return null
  })
}

export async function addGitignore(key: Uint8Array, req: EnvFile): Promise<GitignoreResult> {
  const file = fileOf(req)
  const cfg = await configured()
  const envDir = await requireFolder(cfg, file)
  await withEntryKeys(key, async (keys) => {
    const snapshot = await cfg.vault.snapshot()
    requireSynced((await snapshot.settings(keys)).settings, storedFile(cfg, file), file.repoName)
  })
  return addToGitignore(
    await resolveRepo(cfg.projectsPath, file.repoName),
    envDir,
    envFileName(file.path)
  )
}

// ---------------------------------------------------------------------------

/**
 * The env file the envvault command means in `dir`, its working directory:
 * `path` in the repo that contains it, or else the env file the repo syncs in
 * the nearest folder at or above `dir` (.env if there are several, and
 * ENV_AMBIGUOUS if none of them is .env), or else the repo's root .env.
 * REPO_IGNORED for an ignored repo.
 */
export async function envTargetAt(key: Uint8Array, dir: string, path?: string): Promise<EnvFile> {
  const cfg = await configured()
  const at = await repoAt(cfg.projectsPath, dir)
  const vaultName = entryId(vaultNameOf(cfg, at.name))
  const settings = await withEntryKeys(
    key,
    async (keys) => (await (await cfg.vault.snapshot()).settings(keys)).settings
  )
  if (repoRules(settings, vaultName).ignored) {
    throw new AppError('REPO_IGNORED', `${at.name} is ignored in EnvVault.`)
  }
  if (path !== undefined) return { repoName: at.name, path }
  const rules = effectiveRules(settings, vaultName)
  for (let n = at.folders.length; n >= 0; n--) {
    const synced = (await envFilesIn(at.dir, at.folders.slice(0, n))).filter((p) =>
      isIncluded(p, rules)
    )
    const plain = synced.find((p) => envFileName(p) === ROOT_ENV)
    const only = synced.length === 1 ? synced[0] : undefined
    const found = plain ?? only
    if (found) return { repoName: at.name, path: found }
    if (synced.length > 1) {
      throw new AppError(
        'ENV_AMBIGUOUS',
        `This folder has ${synced.map(envFileName).join(', ')}. Pick one with --path, as in --path ${synced[0]}.`
      )
    }
  }
  return { repoName: at.name, path: ROOT_ENV }
}

/** The name of the repo that contains `dir` (see envTargetAt). */
export async function repoNameAt(dir: string): Promise<string> {
  return (await repoAt((await configured()).projectsPath, dir)).name
}

// ---------------------------------------------------------------------------
// Repo settings: in the vault for every machine, except the name a folder
// syncs as, which is this machine's (Settings.repoNames).

const SETTINGS_ATTEMPTS = 3

/**
 * Change the vault's settings with `change` (null: nothing to change) and
 * write them. Two machines changing them at once: the later one reads them
 * again and makes its change on top, so neither change is lost. Settings that
 * can't be read can't be changed (see resetSettings).
 */
async function changeSettings(
  key: Uint8Array,
  change: (settings: VaultSettings) => VaultSettings | null
): Promise<null> {
  const cfg = await configured()
  return withEntryKeys(key, async (keys) => {
    for (let attempt = 1; ; attempt++) {
      const read = await (await cfg.vault.snapshot()).settings(keys)
      if (read.error) throw read.error
      const next = change(read.settings)
      if (next === null) return null
      try {
        await cfg.vault.writeSettings(keys, stamped(next, cfg.machineName), read.version)
        return null
      } catch (err) {
        const conflict = err instanceof AppError && err.code === 'VAULT_CHANGED'
        if (!conflict || attempt >= SETTINGS_ATTEMPTS) throw err
      }
    }
  })
}

const stamped = (settings: VaultSettings, machineName: string): VaultSettings => ({
  ...settings,
  updatedBy: machineName,
  updatedAt: new Date().toISOString()
})

/** Save a repo's settings, by its vault name, for every machine. */
export function saveRepoSettings(key: Uint8Array, req: RepoSettingsRequest): Promise<null> {
  const id = entryId(req.vaultName)
  const rules = { ignored: req.ignored, include: req.include, exclude: req.exclude }
  return changeSettings(key, (settings) =>
    sameRepoRules(repoRules(settings, id), rules) ? null : withRepo(settings, id, rules)
  )
}

/** Save the rules repos without their own use, for every machine. */
export function saveDefaults(key: Uint8Array, rules: FileRules): Promise<null> {
  return changeSettings(key, (settings) =>
    sameFileRules(settings.defaults, rules) ? null : withDefaults(settings, rules)
  )
}

/**
 * Replace settings that failed verification with empty ones. Settings from a
 * newer EnvVault are never replaced: updating this one is the fix.
 */
export async function resetSettings(key: Uint8Array): Promise<null> {
  const cfg = await configured()
  return withEntryKeys(key, async (keys) => {
    const read = await (await cfg.vault.snapshot()).settings(keys)
    if (!read.error) return null
    if (read.error.code !== 'VAULT_TAMPERED') throw read.error
    await cfg.vault.writeSettings(keys, stamped(emptySettings(), cfg.machineName), read.version)
    return null
  })
}

/**
 * Sync the folder `repoName` as `vaultName` in the vault, on this machine
 * only. Its own name (in any case) syncs it as itself again.
 */
export async function setVaultName(req: VaultNameRequest): Promise<null> {
  const cfg = await configured()
  await resolveRepo(cfg.projectsPath, req.repoName)
  const folder = entryId(req.repoName)
  const repoNames = Object.fromEntries(
    Object.entries(cfg.repoNames).filter(([id]) => id !== folder)
  )
  if (entryId(req.vaultName) !== folder) {
    if (Object.keys(repoNames).length >= MAX_REPO_NAMES) {
      throw new AppError(
        'BAD_REQUEST',
        `At most ${MAX_REPO_NAMES} folders can sync under another name.`
      )
    }
    repoNames[folder] = req.vaultName
  }
  await updateConfig({ repoNames })
  return null
}
