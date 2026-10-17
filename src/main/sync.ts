// Push / pull flows. Every function takes a private copy of the key (see
// session.withKey) and returns metadata and key names only, never values,
// except pullRawDiff, which the user asks for explicitly. Serialisation (one
// write at a time) is done by the IPC handlers.
import { decodeEnv, encryptPayload, makePayload, sha256Hex, type Payload } from '../core/crypto'
import { diffKeys, parseEnv } from '../core/envdiff'
import { lineDiff } from '../core/linediff'
import { computeStatus, needsOverwriteConfirm, nextVersion } from '../core/status'
import type {
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
  Settings,
  VaultInfo
} from '../shared/types'
import { getConfig } from './config'
import { AppError } from './errors'
import { atomicWrite, isErrno, randomHex, writeNew } from './fsutil'
import { addToGitignore, checkIgnored, ignoreStatus, isTracked } from './git'
import { readLocalEnv, resolveRepo, scanRepos, type ScannedRepo } from './repos'
import { getLast, setLast } from './state'
import { entryId, listEntryIds, readEntry, writeEntry } from './vault'

type Configured = Settings & { projectsPath: string; vaultPath: string }

async function configured(): Promise<Configured> {
  const cfg = await getConfig()
  if (!cfg.projectsPath || !cfg.vaultPath) {
    throw new AppError('NOT_CONFIGURED', 'Choose a projects folder and a vault folder first.')
  }
  return { ...cfg, projectsPath: cfg.projectsPath, vaultPath: cfg.vaultPath }
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

export async function listRepos(key: Uint8Array, vaultId: string): Promise<RepoRow[]> {
  const cfg = await configured()
  const [scanned, entryIds] = await Promise.all([
    scanRepos(cfg.projectsPath),
    listEntryIds(cfg.vaultPath)
  ])
  const ids = new Set(entryIds)

  const row = async (name: string, repo: ScannedRepo | null, id: string): Promise<RepoRow> => {
    const hasEnv = repo !== null && (repo.localHash !== null || repo.envError !== null)
    try {
      if (repo?.envError) throw repo.envError
      const payload = ids.has(id) ? await readEntry(cfg.vaultPath, key, id) : null
      const vault = payload ? toInfo(payload) : null
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
    jobs.push(row(repo.name, repo, id))
  }
  for (const id of ids) if (!seen.has(id)) jobs.push(row(id, null, id))
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
  localHash: string | null
  payload: Payload | null
  vault: VaultInfo | null
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
  try {
    const payload = await readEntry(cfg.vaultPath, key, id)
    return await fn({
      cfg,
      repoDir,
      id,
      local,
      localHash: local ? sha256Hex(local) : null,
      payload,
      vault: payload ? toInfo(payload) : null
    })
  } finally {
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

const noLocalEnv = (): AppError => new AppError('ENV_NOT_FOUND', 'This repo has no .env to push.')
const noVaultCopy = (): AppError =>
  new AppError('VAULT_ENTRY_NOT_FOUND', 'The vault has no copy of this repo.')

export function previewPush(
  key: Uint8Array,
  vaultId: string,
  repoName: string
): Promise<PushPreview> {
  return withSnapshot(key, repoName, async (s) => {
    if (!s.local) throw noLocalEnv()
    const last = await getLast(vaultId, s.id)
    return {
      diff: diffKeys(
        parseAndWipe(Buffer.from(s.local)),
        parseAndWipe(s.payload ? decodeEnv(s.payload) : null)
      ),
      needsOverwrite: needsOverwriteConfirm(s.vault, last),
      vault: s.vault,
      sameContent: s.localHash === s.vault?.contentHash,
      expected: expectedOf(s)
    }
  })
}

export function push(key: Uint8Array, vaultId: string, req: PushRequest): Promise<RepoRow> {
  return withSnapshot(key, req.repoName, async (s) => {
    if (!s.local || !s.localHash) throw noLocalEnv()
    checkExpected(s, req.expected)
    const last = await getLast(vaultId, s.id)
    if (needsOverwriteConfirm(s.vault, last) && !req.overwriteConfirmed) {
      throw new AppError(
        'OVERWRITE_NOT_CONFIRMED',
        'The vault copy was changed elsewhere. Confirm the overwrite to continue.'
      )
    }
    let vault = s.vault
    if (!vault || vault.contentHash !== s.localHash) {
      const payload = makePayload(s.local, nextVersion(vault, last), s.cfg.machineName)
      await writeEntry(s.cfg.vaultPath, s.id, await encryptPayload(key, s.id, payload))
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
    return {
      diff: diffKeys(
        parseAndWipe(decodeEnv(s.payload)),
        parseAndWipe(s.local ? Buffer.from(s.local) : null)
      ),
      vault: s.vault,
      hasLocal: s.local !== null,
      ...git,
      rollback: last !== null && s.vault.version < last.version,
      sameContent: s.localHash === s.vault.contentHash,
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
    const vaultBytes = decodeEnv(s.payload)
    try {
      const lines = lineDiff(s.local?.toString('utf8') ?? '', vaultBytes.toString('utf8'), {
        mask: !req.values
      })
      return { lines }
    } finally {
      vaultBytes.fill(0)
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

    let backupName: string | null = null
    if (s.localHash !== s.vault.contentHash) {
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
      const bytes = decodeEnv(s.payload)
      try {
        await atomicWrite(s.repoDir, '.env', bytes, { tmpName, mode: 0o600 })
      } finally {
        bytes.fill(0)
      }
    }
    await setLast(vaultId, s.id, { version: s.vault.version, contentHash: s.vault.contentHash })
    return { backupName }
  })
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

export async function addGitignore(repoName: string): Promise<GitignoreResult> {
  const cfg = await configured()
  return addToGitignore(await resolveRepo(cfg.projectsPath, repoName))
}
