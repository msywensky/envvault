// Push / pull flows. Every function takes a private copy of the key (see
// session.withKey) and returns metadata and key names only, never values,
// except pullRawDiff, which the user asks for explicitly. Serialisation (one
// write at a time) is done by the IPC handlers. Machine-specific keys
// (# envvault:local, see core/localkeys) are blanked in what a push uploads
// and status hashes, and kept from the local file by a pull.
import { decodeEnv, encryptPayload, makePayload, sha256Hex, type Payload } from '../core/crypto'
import { diffKeys, parseEnv } from '../core/envdiff'
import { applyEdits, DuplicateKeyError, EditError, editorEntries } from '../core/envedit'
import { compareExample } from '../core/example'
import { lineDiff } from '../core/linediff'
import { markedKeys, unmarkedKeys } from '../core/localkeys'
import { computeStatus, needsOverwriteConfirm, nextVersion } from '../core/status'
import type {
  EditorData,
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
  RepoRow,
  SaveEditRequest,
  SaveEditResult,
  Settings,
  VaultInfo
} from '../shared/types'
import { getConfig } from './config'
import { AppError } from './errors'
import { atomicWrite, isErrno, randomHex, writeNew } from './fsutil'
import { addToGitignore, checkIgnored, ignoreStatus, isTracked } from './git'
import { mergedBytes, syncedBytes } from './localkeys'
import {
  MAX_ENV_BYTES,
  readLocalEnv,
  readRepoFile,
  resolveRepo,
  scanRepos,
  type ScannedRepo
} from './repos'
import { getLast, setLast } from './state'
import { entryId, vaultFor, type Vault } from './vault'

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

// ---------------------------------------------------------------------------

/** Every repo's row, or with `only`, just that repo's (an empty list if there is none). */
export async function listRepos(
  key: Uint8Array,
  vaultId: string,
  only?: string
): Promise<RepoRow[]> {
  const cfg = await configured()
  const onlyId = only === undefined ? null : entryId(only)
  // One snapshot for every row, so the list is one consistent view of the vault.
  const [scanned, snapshot] = await Promise.all([scanRepos(cfg.projectsPath), cfg.vault.snapshot()])
  const ids = new Set(snapshot.ids)

  const row = async (name: string, repo: ScannedRepo | null, id: string): Promise<RepoRow> => {
    const hasEnv = repo !== null && (repo.localHash !== null || repo.envError !== null)
    try {
      if (repo?.envError) throw repo.envError
      const entry = ids.has(id) ? await snapshot.read(key, id) : null
      const vault = entry ? toInfo(entry.payload) : null
      const last = await getLast(vaultId, id)
      const status = computeStatus({
        repoExists: repo !== null,
        localHash: repo?.localHash ?? null,
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
        await setLast(vaultId, id, { version: vault.version, contentHash: vault.contentHash })
      }
      return { name, status, hasEnv, vault, error: null }
    } catch (err) {
      if (!(err instanceof AppError)) throw err
      return {
        name,
        status: 'error',
        hasEnv,
        vault: null,
        error: { code: err.code, message: err.message }
      }
    }
  }

  // Two folders differing only by case map to one entry; keep the first.
  const seen = new Set<string>()
  const jobs: Promise<RepoRow>[] = []
  for (const repo of scanned) {
    const id = entryId(repo.name)
    if (seen.has(id)) continue
    seen.add(id)
    if (onlyId === null || id === onlyId) jobs.push(row(repo.name, repo, id))
  }
  for (const id of ids) {
    if (!seen.has(id) && (onlyId === null || id === onlyId)) jobs.push(row(id, null, id))
  }
  const rows = await Promise.all(jobs)
  return rows.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
}

// ---------------------------------------------------------------------------

interface Snapshot {
  cfg: Configured
  repoDir: string
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

/** Read the current local and vault state, run `fn`, then wipe the plaintext. */
async function withSnapshot<T>(
  key: Uint8Array,
  repoName: string,
  fn: (s: Snapshot) => Promise<T>
): Promise<T> {
  const cfg = await configured()
  const repoDir = await resolveRepo(cfg.projectsPath, repoName)
  const id = entryId(repoName)
  const local = await readLocalEnv(repoDir)
  let synced: Buffer | null = null
  try {
    synced = local ? syncedBytes(local) : null
    const entry = await (await cfg.vault.snapshot()).read(key, id)
    const payload = entry?.payload ?? null
    return await fn({
      cfg,
      repoDir,
      id,
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

const EXAMPLE = '.env.example'

/**
 * How `env` compares with the repo's .env.example, or null if there is none.
 * Advisory only: a file that can't be read is reported, never thrown.
 */
async function checkExample(
  repoDir: string,
  env: Map<string, string>
): Promise<ExampleCheck | null> {
  let bytes: Buffer | null
  try {
    bytes = await readRepoFile(repoDir, EXAMPLE)
  } catch (err) {
    // Node's own messages contain paths, so only ours are passed on.
    const message = err instanceof AppError ? err.message : `${EXAMPLE} could not be read.`
    return { status: 'unreadable', message }
  }
  if (!bytes) return null
  const diff = compareExample(env, parseAndWipe(bytes))
  // Only needed to word the same-value warning; push previews work without git.
  const tracked =
    diff.sameValue.length > 0 ? await isTracked(repoDir, EXAMPLE).catch(() => null) : null
  return { status: 'ok', tracked, ...diff }
}

const noLocalEnv = (): AppError => new AppError('ENV_NOT_FOUND', 'This repo has no .env to push.')
const noVaultCopy = (): AppError =>
  new AppError('VAULT_ENTRY_NOT_FOUND', 'The vault has no copy of this repo.')

export function previewPush(
  key: Uint8Array,
  vaultId: string,
  repoName: string
): Promise<PushPreview> {
  return withSnapshot(key, repoName, async (s) => {
    if (!s.local || !s.synced) throw noLocalEnv()
    const last = await getLast(vaultId, s.id)
    // The raw file: machine-specific values don't belong in the example either.
    const example = s.cfg.checkExample
      ? await checkExample(s.repoDir, parseAndWipe(Buffer.from(s.local)))
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
  return withSnapshot(key, req.repoName, async (s) => {
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
      await s.cfg.vault.write(s.id, await encryptPayload(key, s.id, payload), s.vaultVersion)
      vault = toInfo(payload)
    }
    await setLast(vaultId, s.id, { version: vault.version, contentHash: vault.contentHash })
    return { name: req.repoName, status: 'in-sync', hasEnv: true, vault, error: null }
  })
}

// ---------------------------------------------------------------------------

export function previewPull(
  key: Uint8Array,
  vaultId: string,
  repoName: string
): Promise<PullPreview> {
  return withSnapshot(key, repoName, async (s) => {
    if (!s.payload || !s.vault) throw noVaultCopy()
    const [last, git] = await Promise.all([getLast(vaultId, s.id), ignoreStatus(s.repoDir)])
    const merged = mergedBytes(decodeEnv(s.payload), s.local)
    const mergedHash = sha256Hex(merged.bytes)
    // Both compare what the pull writes, so kept keys don't show as changed.
    const mergedEnv = parseAndWipe(merged.bytes)
    const example = s.cfg.checkExample ? await checkExample(s.repoDir, mergedEnv) : null
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
  return withSnapshot(key, req.repoName, async (s) => {
    if (!s.payload || !s.vault) throw noVaultCopy()
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
  return withSnapshot(key, req.repoName, async (s) => {
    if (!s.payload || !s.vault) throw noVaultCopy()
    checkExpected(s, req.expected)
    const [tracked, ignored] = await Promise.all([
      isTracked(s.repoDir, '.env'),
      checkIgnored(s.repoDir, '.env')
    ])
    if (tracked) {
      throw new AppError(
        'ENV_TRACKED',
        '.env is committed to git. Run `git rm --cached .env`, commit, then retry.'
      )
    }
    if (!ignored) throw new AppError('ENV_NOT_IGNORED', '.env is not in .gitignore. Add it first.')

    return { backupName: await applyPull(s, s.payload, s.vault, vaultId) }
  })
}

/**
 * Pull without review when the change is one-sided: the vault copy is newer
 * and the local .env is unchanged since this machine's last sync (or
 * missing), and git would ignore what a pull writes. Anything else
 * (conflict, rollback, git not set up) is left for the user. Returns the
 * updated row, or null if it didn't pull.
 */
export function autoPull(
  key: Uint8Array,
  vaultId: string,
  repoName: string
): Promise<RepoRow | null> {
  return withSnapshot(key, repoName, async (s) => {
    if (!s.payload || !s.vault) return null
    const last = await getLast(vaultId, s.id)
    const status = computeStatus({
      repoExists: true,
      localHash: s.syncedHash,
      vault: s.vault,
      last
    })
    if (status !== 'vault-newer') return null
    const git = await ignoreStatus(s.repoDir)
    if (!git.ignored || !git.backupIgnored || git.tracked) return null
    await applyPull(s, s.payload, s.vault, vaultId)
    return { name: repoName, status: 'in-sync', hasEnv: true, vault: s.vault, error: null }
  })
}

/**
 * Write the vault copy, merged with this machine's machine-specific lines,
 * over the local .env (backing it up first) and record the sync. The caller
 * has checked that .env is git-ignored and untracked. Returns the backup's
 * name, or null if there was nothing to back up or nothing changed.
 */
async function applyPull(
  s: Snapshot,
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
      const wantBackup = s.local ? `.env.bak.${backupStamp(new Date())}` : null
      for (const name of [tmpName, wantBackup]) {
        if (name && !(await checkIgnored(s.repoDir, name))) {
          throw new AppError(
            'BACKUP_NOT_IGNORED',
            `${name} would not be ignored by git. Add ".env.bak.*" to .gitignore.`
          )
        }
      }
      if (s.local && wantBackup) backupName = await writeBackup(s.repoDir, wantBackup, s.local)
      await atomicWrite(s.repoDir, '.env', bytes, { tmpName, mode: 0o600 })
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
async function writeBackup(repoDir: string, name: string, bytes: Buffer): Promise<string> {
  for (const candidate of [name, `${name}-${randomHex(2)}`]) {
    try {
      await writeNew(repoDir, candidate, bytes, 0o600)
      return candidate
    } catch (err) {
      if (!isErrno(err, 'EEXIST')) throw err
    }
  }
  throw new AppError('FS_ERROR', 'Could not create a unique backup file name.')
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

/** The vault copy of a repo in the projects folder, as editor rows. */
export async function openEditor(key: Uint8Array, repoName: string): Promise<EditorData> {
  const cfg = await configured()
  await resolveRepo(cfg.projectsPath, repoName)
  const entry = await (await cfg.vault.snapshot()).read(key, entryId(repoName))
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
  const cfg = await configured()
  await resolveRepo(cfg.projectsPath, req.repoName)
  const id = entryId(req.repoName)
  const entry = await (await cfg.vault.snapshot()).read(key, id)
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
      nextVersion(vault, await getLast(vaultId, id)),
      cfg.machineName
    )
    try {
      await cfg.vault.write(id, await encryptPayload(key, id, next), entry?.version ?? null)
    } catch (err) {
      if (err instanceof AppError && err.code === 'VAULT_CHANGED') throw editorStale()
      throw err
    }
    return { vault: toInfo(next), changed: true }
  } finally {
    if (synced !== edited) synced?.fill(0)
    edited.fill(0)
  }
}

// ---------------------------------------------------------------------------

export async function addGitignore(repoName: string): Promise<GitignoreResult> {
  const cfg = await configured()
  return addToGitignore(await resolveRepo(cfg.projectsPath, repoName))
}
