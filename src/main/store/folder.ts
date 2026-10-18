// A vault in a folder, usually one synced between machines by Google Drive
// or similar:
//   meta.json            plaintext: format version, vaultId, KDF params, salt, keyCheck
//   <id>.env.enc         one encrypted entry per repo
//   .<name>.<hex>.tmp    in-flight atomic writes (ours; removed when stale)
// Anything else (Drive conflict copies, user files) is ignored.
import { readFile, readdir, rm, stat } from 'node:fs/promises'
import { resolveInside } from '../../core/paths'
import { atomicWrite, isErrno, writeNew } from '../fsutil'
import { checkName, isStoreName, StoreExistsError, type VaultStore } from './types'

// atomicWrite's temp names: ".<final>.<16 hex>.tmp". The random suffix keeps
// two machines' in-flight files (which Drive may sync) from colliding.
const TEMP_RE = /^\.([a-z0-9][a-z0-9._-]*)\.[0-9a-f]{16}\.tmp$/
const STALE_TEMP_MS = 10 * 60_000

export class FolderStore implements VaultStore {
  constructor(private readonly dir: string) {}

  async reachable(): Promise<boolean> {
    try {
      return (await stat(this.dir)).isDirectory()
    } catch {
      return false
    }
  }

  async list(): Promise<string[]> {
    return (await readdir(this.dir)).filter(isStoreName)
  }

  async get(name: string): Promise<Uint8Array | null> {
    checkName(name)
    try {
      return await readFile(resolveInside(this.dir, name))
    } catch (err) {
      if (isErrno(err, 'ENOENT')) return null
      throw err
    }
  }

  // Exclusive create, never rename-over: of two machines creating at once
  // (Drive syncing one in), the first file wins and the other fails.
  async create(name: string, bytes: Uint8Array): Promise<void> {
    checkName(name)
    try {
      await writeNew(this.dir, name, bytes, 0o644)
    } catch (err) {
      if (isErrno(err, 'EEXIST')) throw new StoreExistsError()
      throw err
    }
  }

  async put(name: string, bytes: Uint8Array): Promise<void> {
    checkName(name)
    await atomicWrite(this.dir, name, bytes, { mode: 0o644 })
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
}
