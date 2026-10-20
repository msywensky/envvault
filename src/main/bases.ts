// Merge bases: the content this machine last synced of each env file, so a
// file changed on both sides can be merged three-way (see core/envmerge).
// One file per state.json key, per vault, named by a hash of the key so no
// repo name shows. Each is sealed under a key derived from the vault key and
// bound to the exact version and hash state.json records, so a stale,
// swapped or tampered base never opens. A missing base only means the merge
// is two-way, so nothing here fails a sync.
import { app } from 'electron'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { openBase, sealBase, sha256Hex } from '../core/crypto'
import type { LastSync } from '../shared/types'
import { atomicWrite, isErrno } from './fsutil'
import { MAX_ENV_BYTES } from './repos'

const DIR = 'bases'
// Room for the file header, nonce and tag around the largest env file.
const MAX_SEALED = MAX_ENV_BYTES + 64
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The vault's folder of bases, or null for an id that isn't a UUID (never a path). */
function dirOf(vaultId: string): string | null {
  return UUID_RE.test(vaultId) ? join(app.getPath('userData'), DIR, vaultId.toLowerCase()) : null
}

const nameOf = (stateId: string): string =>
  `${sha256Hex(Buffer.from(stateId, 'utf8')).slice(0, 32)}.enc`

const errName = (err: unknown): string => (err instanceof Error ? err.name : 'unknown')

/** Keep `bytes` as the base of `stateId`'s last sync, `last`. Best effort. */
export async function saveBase(
  key: Uint8Array,
  vaultId: string,
  stateId: string,
  last: LastSync,
  bytes: Uint8Array
): Promise<void> {
  const dir = dirOf(vaultId)
  if (!dir) return
  try {
    const sealed = await sealBase(key, { vaultId, stateId, ...last }, bytes)
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await atomicWrite(dir, nameOf(stateId), sealed, { mode: 0o600 })
  } catch (err) {
    console.error(`[envvault] saving a merge base failed: ${errName(err)}`)
  }
}

/**
 * The base of `stateId`'s last sync, `last`, or null if there is none that
 * opens for exactly that sync. The caller wipes the result.
 */
export async function loadBase(
  key: Uint8Array,
  vaultId: string,
  stateId: string,
  last: LastSync | null
): Promise<Buffer | null> {
  const dir = dirOf(vaultId)
  if (!dir || !last) return null
  let sealed: Buffer
  try {
    sealed = await readFile(join(dir, nameOf(stateId)))
  } catch (err) {
    if (!isErrno(err, 'ENOENT'))
      console.error(`[envvault] reading a merge base failed: ${errName(err)}`)
    return null
  }
  if (sealed.length > MAX_SEALED) return null
  let opened: Uint8Array | null = null
  try {
    opened = await openBase(key, { vaultId, stateId, ...last }, sealed)
    const bytes = Buffer.from(opened)
    if (sha256Hex(bytes) === last.contentHash) return bytes
    bytes.fill(0)
    return null
  } catch {
    // Stale (another sync since), swapped or tampered: as if there were none.
    return null
  } finally {
    opened?.fill(0)
  }
}

/** Delete `stateId`'s base, if any. Best effort. */
export async function forgetBase(vaultId: string, stateId: string): Promise<void> {
  const dir = dirOf(vaultId)
  if (!dir) return
  try {
    await rm(join(dir, nameOf(stateId)), { force: true })
  } catch (err) {
    console.error(`[envvault] removing a merge base failed: ${errName(err)}`)
  }
}
