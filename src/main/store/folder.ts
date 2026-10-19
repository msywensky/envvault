// A vault in a folder, usually one synced between machines by Google Drive
// or similar:
//   meta.json            plaintext: format version, vaultId, KDF params, salt, keyCheck
//   <id>.env.enc         one encrypted entry per repo
//   .<name>.<hex>.tmp    in-flight atomic writes (ours; removed when stale)
// Anything else (Drive conflict copies, user files) is ignored.
//
// A folder has no versions or transactions, so this is best-effort: a
// snapshot lists the folder now and reads each file when asked, and a write
// or delete re-reads the file and compares its hash with `expected` before
// replacing or removing it. That's exact within this process (writes are
// queued) and as good as Drive allows between machines.
import { readFile, readdir, rm, stat } from 'node:fs/promises'
import { resolveInside } from '../../core/paths'
import { atomicWrite, isErrno, removeFile } from '../fsutil'
import { createSerial } from '../mutex'
import {
  checkName,
  contentVersion,
  isStoreName,
  StoreConflictError,
  type StoreSnapshot,
  type VaultStore
} from './types'

// atomicWrite's temp names: ".<final>.<16 hex>.tmp". The random suffix keeps
// two machines' in-flight files (which Drive may sync) from colliding.
const TEMP_RE = /^\.([a-z0-9][a-z0-9._-]*)\.[0-9a-f]{16}\.tmp$/
const STALE_TEMP_MS = 10 * 60_000

export class FolderStore implements VaultStore {
  readonly kind = 'folder'
  // Each write's check and replace must not interleave with another's.
  private readonly serial = createSerial()

  constructor(private readonly dir: string) {}

  async reachable(): Promise<boolean> {
    try {
      return (await stat(this.dir)).isDirectory()
    } catch {
      return false
    }
  }

  /** A folder needs no checks beyond being reachable. */
  async check(): Promise<void> {
    return undefined
  }

  async snapshot(): Promise<StoreSnapshot> {
    const names = (await readdir(this.dir)).filter(isStoreName)
    return {
      names,
      get: async (name) => {
        const bytes = await this.read(name)
        return bytes ? { bytes, version: contentVersion(bytes) } : null
      }
    }
  }

  // Check, then rename over. A meta.json used to be created with O_EXCL;
  // now another process could slip one in between the check and the
  // rename, a window of milliseconds that vault.ts narrows further by
  // re-checking the vault state right before it creates one.
  async write(name: string, bytes: Uint8Array, expected: string | null): Promise<string> {
    checkName(name)
    return this.serial(async () => {
      const current = await this.read(name)
      if ((current ? contentVersion(current) : null) !== expected) throw new StoreConflictError()
      await atomicWrite(this.dir, name, bytes, { mode: 0o644 })
      return contentVersion(bytes)
    })
  }

  async delete(name: string, expected: string): Promise<void> {
    checkName(name)
    await this.serial(async () => {
      const current = await this.read(name)
      if (!current || contentVersion(current) !== expected) throw new StoreConflictError()
      await removeFile(this.dir, name)
    })
  }

  /** Remove our own temp files left by a crash. Recent ones may be in flight. */
  async cleanUp(): Promise<void> {
    const now = Date.now()
    for (const name of await readdir(this.dir)) {
      const target = TEMP_RE.exec(name)?.[1]
      if (!target || !isStoreName(target)) continue
      const file = resolveInside(this.dir, name)
      const info = await stat(file)
      if (now - info.mtimeMs > STALE_TEMP_MS) await rm(file, { force: true })
    }
  }

  private async read(name: string): Promise<Buffer | null> {
    checkName(name)
    try {
      return await readFile(resolveInside(this.dir, name))
    } catch (err) {
      if (isErrno(err, 'ENOENT')) return null
      throw err
    }
  }
}
