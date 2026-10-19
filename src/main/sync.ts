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
import { ROOT_ENV, envFileName, envFolders, envPathId } from '../core/envpath'
import { applyEdits, DuplicateKeyError, EditError, editorEntries } from '../core/envedit'
import { compareExample } from '../core/example'
import { lineDiff } from '../core/linediff'
import { markedKeys, unmarkedKeys } from '../core/localkeys'
import { computeStatus, needsOverwriteConfirm, nextVersion } from '../core/status'
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
  RepoRow,
  SaveEditRequest,
  SaveEditResult,
  Settings,
  VaultInfo
} from '../shared/types'
import { getConfig } from './config'
import { AppError, errnoCode } from './errors'
import { atomicWrite, isErrno, randomHex, writeNew } from './fsutil'
import { addToGitignore, checkIgnored, ignoreStatus, isTracked } from './git'
import { mergedBytes, syncedBytes } from './localkeys'
import {
  MAX_ENV_BYTES,
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

// ---------------------------------------------------------------------------

export interface ListOptions {
  /** Only this repo's rows (none if it is neither in the projects folder nor the vault). */
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

/** One row per env file, of every repo, sorted by repo with each root .env first. */
export async function listRepos(
  key: Uint8Array,
  vaultId: string,
  opts: ListOptions = {}
): Promise<RepoRow[]> {
  const cfg = await configured()
  const onlyId = opts.only === undefined ? null : entryId(opts.only)
  // One snapshot for every row, so the list is one consistent view of the vault.
  const [scanned, snapshot] = await Promise.all([
    scanRepos(cfg.projectsPath, { find: opts.find, only: opts.only }),
    cfg.vault.snapshot()
  ])
  return withEntryKeys(key, async (keys) => {
    // Every entry is read for its status anyway, which is also how a file
    // entry's path is learnt.
    const listed = await Promise.all(
      snapshot.entries
        .filter((ref) => onlyId === null || ref.repoId === onlyId)
        .map((ref) => listEntry(snapshot, keys, ref))
    )
    const inVault = new Map<string, Listed[]>()
    for (const l of listed) inVault.set(l.ref.repoId, [...(inVault.get(l.ref.repoId) ?? []), l])

    // Two folders differing only by case map to one repo id; keep the first.
    const seen = new Set<string>()
    const jobs: Promise<RepoRow[]>[] = []
    for (const repo of scanned) {
      const id = entryId(repo.name)
      if (seen.has(id)) continue
      seen.add(id)
      jobs.push(repoRows(keys, vaultId, repo.name, repo, inVault.get(id) ?? []))
    }
    for (const [id, entries] of inVault) {
      if (!seen.has(id)) jobs.push(repoRows(keys, vaultId, id, null, entries))
    }
    return (await Promise.all(jobs)).flat().sort(byFile)
  })
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
 * One repo's rows: each env file it has or the vault has a copy of, and its
 * root .env if that exists on either side or there is nothing else (so every
 * repo is listed, and Edit can start its vault copy). `repo` is null for a
 * repo that is only in the vault.
 */
async function repoRows(
  keys: EntryKeys,
  vaultId: string,
  name: string,
  repo: ScannedRepo | null,
  listed: Listed[]
): Promise<RepoRow[]> {
  const files = new Map<string, FileState>()
  for (const scan of repo?.files ?? []) {
    const id = envPathId(scan.path)
    if (!files.has(id)) files.set(id, { path: scan.path, scan, listed: null })
  }
  const unreadable: Listed[] = []
  for (const l of listed) {
    // A file entry that couldn't be read has no path to go by. (One that
    // vanished since the snapshot was taken has neither entry nor error.)
    if (l.path === null) {
      if (l.error) unreadable.push(l)
      continue
    }
    const file = files.get(envPathId(l.path))
    if (file) file.listed = l
    else files.set(envPathId(l.path), { path: l.path, scan: null, listed: l })
  }
  // Vault copies of files git didn't report (or wasn't asked about this time).
  if (repo) {
    await Promise.all(
      [...files.values()]
        .filter((f) => f.scan === null)
        .map(async (f) => {
          f.scan = await scanEnvFile(repo.dir, f.path)
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
  const showRoot =
    root !== undefined &&
    (inVault(root) || hasLocal(root) || (others.length === 0 && unreadable.length === 0))

  const row = async (f: FileState): Promise<RepoRow> => {
    const ref = f.listed?.ref ?? entryFor(keys, { repoName: name, path: f.path })
    const base = {
      name,
      path: f.path,
      storedName: inVault(f) ? entryName(ref) : null,
      hasEnv: hasLocal(f)
    }
    try {
      if (f.scan?.envError) throw f.scan.envError
      if (f.listed?.error) throw f.listed.error
      const vault = f.listed?.entry ? toInfo(f.listed.entry.payload) : null
      const last = await getLast(vaultId, stateKey(ref))
      const status = computeStatus({
        repoExists: repo !== null && (f.scan?.folderExists ?? false),
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
        await setLast(vaultId, stateKey(ref), {
          version: vault.version,
          contentHash: vault.contentHash
        })
      }
      return { ...base, status, vault, error: null }
    } catch (err) {
      if (!(err instanceof AppError)) throw err
      return {
        ...base,
        status: 'error',
        vault: null,
        error: { code: err.code, message: err.message }
      }
    }
  }

  const rows = await Promise.all([...(showRoot ? [root] : []), ...others].map(row))
  return [
    ...rows,
    ...unreadable.map((l): RepoRow => ({
      name,
      path: null,
      storedName: entryName(l.ref),
      status: 'error',
      hasEnv: false,
      vault: null,
      error: l.error ? { code: l.error.code, message: l.error.message } : null
    }))
  ]
}

const fileRank = (row: RepoRow): number => (row.path === ROOT_ENV ? 0 : row.path === null ? 2 : 1)

function byFile(a: RepoRow, b: RepoRow): number {
  return (
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) ||
    fileRank(a) - fileRank(b) ||
    (a.path ?? a.storedName ?? '').localeCompare(b.path ?? b.storedName ?? '')
  )
}

// ---------------------------------------------------------------------------

interface Snapshot {
  cfg: Configured
  keys: EntryKeys
  file: EnvFile
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

/** Read the current local and vault state of one env file, run `fn`, then wipe the plaintext. */
async function withSnapshot<T>(
  key: Uint8Array,
  req: EnvFile,
  fn: (s: Snapshot) => Promise<T>
): Promise<T> {
  const file = fileOf(req)
  const cfg = await configured()
  const repoDir = await resolveRepo(cfg.projectsPath, file.repoName)
  const envDir = await resolveEnvDir(repoDir, file.path)
  return withEntryKeys(key, async (keys) => {
    const ref = entryFor(keys, file)
    const local = envDir ? await readEnvFile(envDir, file.path) : null
    let synced: Buffer | null = null
    try {
      synced = local ? syncedBytes(local) : null
      const entry = await (await cfg.vault.snapshot()).read(keys, ref)
      const payload = entry?.payload ?? null
      return await fn({
        cfg,
        keys,
        file,
        ref,
        repoDir,
        envDir,
        id: stateKey(ref),
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
  path: s.file.path,
  storedName: entryName(s.ref),
  status: 'in-sync',
  hasEnv: true,
  vault,
  error: null
})

const EXAMPLE = '.env.example'

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
    const example = s.cfg.checkExample
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
      await s.cfg.vault.write(s.keys, s.file, payload, s.vaultVersion)
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
    const [last, git] = await Promise.all([getLast(vaultId, s.id), ignoreStatus(envDir)])
    const merged = mergedBytes(decodeEnv(s.payload), s.local)
    const mergedHash = sha256Hex(merged.bytes)
    // Both compare what the pull writes, so kept keys don't show as changed.
    const mergedEnv = parseAndWipe(merged.bytes)
    const example = s.cfg.checkExample ? await checkExample(envDir, mergedEnv) : null
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
    const git = await ignoreStatus(s.envDir)
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
  let backupName: string | null = null
  const bytes = mergedBytes(decodeEnv(payload), s.local).bytes
  try {
    if (sha256Hex(bytes) !== s.localHash) {
      // The temp file holds plaintext, so it is named to match .env.bak.*
      // and checked like the backup: a crash must never leave secrets in an
      // un-ignored file.
      const tmpName = `.env.bak.tmp-${randomHex(8)}`
      const wantBackup = s.local && s.cfg.backups ? `.env.bak.${backupStamp(new Date())}` : null
      for (const name of [tmpName, wantBackup]) {
        if (name && !(await checkIgnored(envDir, name))) {
          throw new AppError(
            'BACKUP_NOT_IGNORED',
            `${name} would not be ignored by git. Add ".env.bak.*" to .gitignore.`
          )
        }
      }
      if (s.local && wantBackup) backupName = await writeBackup(envDir, wantBackup, s.local)
      await atomicWrite(envDir, envFileName(s.file.path), bytes, { tmpName, mode: 0o600 })
      // Only once .env is written: a failed pull never costs an older backup.
      if (backupName) await pruneBackups(envDir, s.cfg.backupCount)
    }
  } finally {
    bytes.fill(0)
  }
  await setLast(vaultId, s.id, { version: vault.version, contentHash: vault.contentHash })
  return backupName
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

// What writeBackup names a backup: .env.bak.<stamp>, with -<4 hex> if that
// was taken. Never the pull's temp file (.env.bak.tmp-<hex>) or anyone else's.
const BACKUP_RE = /^\.env\.bak\.\d{8}T\d{6}Z(?:-[0-9a-f]{4})?$/

/**
 * Delete all but the newest `keep` backups in `dir` (the names sort by
 * time). Best effort: the pull has succeeded, and what can't be deleted now
 * is tried again after the next backup.
 */
async function pruneBackups(dir: string, keep: number): Promise<void> {
  let names: string[]
  try {
    names = (await readdir(dir)).filter((name) => BACKUP_RE.test(name)).sort()
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

/** The vault copy of an env file in the projects folder, as editor rows. */
export async function openEditor(key: Uint8Array, req: EnvFile): Promise<EditorData> {
  const file = fileOf(req)
  const cfg = await configured()
  await requireFolder(cfg, file)
  const entry = await withEntryKeys(key, async (keys) =>
    (await cfg.vault.snapshot()).read(keys, entryFor(keys, file))
  )
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
    const ref = entryFor(keys, file)
    const entry = await (await cfg.vault.snapshot()).read(keys, ref)
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
        nextVersion(vault, await getLast(vaultId, stateKey(ref))),
        cfg.machineName
      )
      try {
        await cfg.vault.write(keys, file, next, entry?.version ?? null)
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
 * Delete an env file's vault copy, if it is still the one the user saw. The
 * repo doesn't need to be in the projects folder (a Vault only row), and no
 * local file is touched, here or on any other machine. The copy must decrypt;
 * a broken one shows its stored name, to be deleted by hand.
 */
export async function removeFromVault(
  key: Uint8Array,
  vaultId: string,
  req: RemoveRequest
): Promise<null> {
  const file = fileOf(req)
  const cfg = await configured()
  return withEntryKeys(key, async (keys) => {
    const ref = entryFor(keys, file)
    const entry = await (await cfg.vault.snapshot()).read(keys, ref)
    if (!entry) throw noVaultCopy()
    if (entry.payload.contentHash !== req.expectedVaultHash) {
      throw new AppError(
        'VAULT_CHANGED',
        'The vault copy changed since you looked at it. Check it again before removing it.'
      )
    }
    await cfg.vault.remove(ref, entry.version)
    // A floor for the file's versions on this machine: pushed again from
    // here, it continues above the removed copy, so a machine that synced
    // that copy doesn't take the new one for a rollback.
    const last = await getLast(vaultId, stateKey(ref))
    if (!last || last.version < entry.payload.version) {
      await setLast(vaultId, stateKey(ref), {
        version: entry.payload.version,
        contentHash: entry.payload.contentHash
      })
    }
    return null
  })
}

export async function addGitignore(req: EnvFile): Promise<GitignoreResult> {
  const file = fileOf(req)
  const cfg = await configured()
  const envDir = await requireFolder(cfg, file)
  return addToGitignore(await resolveRepo(cfg.projectsPath, file.repoName), envDir)
}
