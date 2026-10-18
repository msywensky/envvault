// A VaultStore in memory: the reference implementation of the contract in
// types.ts, used by the tests. Settings never selects it. Snapshots are
// exact, and a write checks and sets in one synchronous step.
import {
  checkName,
  contentVersion,
  StoreConflictError,
  type StoreObject,
  type StoreSnapshot,
  type VaultStore
} from './types'

export class MemoryStore implements VaultStore {
  readonly kind = 'memory'
  // Stored objects are never mutated, so a snapshot can share them.
  private readonly objects = new Map<string, StoreObject>()
  private readonly isReachable: boolean

  /** `reachable: false` behaves like a vault folder that doesn't exist. */
  constructor(opts: { reachable?: boolean } = {}) {
    this.isReachable = opts.reachable ?? true
  }

  private guard(name?: string): void {
    if (!this.isReachable) throw new Error('The store is not reachable.')
    if (name !== undefined) checkName(name)
  }

  async reachable(): Promise<boolean> {
    return this.isReachable
  }

  async check(): Promise<void> {
    return undefined
  }

  // Copies out: callers wipe their buffers.
  async snapshot(): Promise<StoreSnapshot> {
    this.guard()
    const objects = new Map(this.objects)
    return {
      names: [...objects.keys()],
      get: async (name) => {
        this.guard(name)
        const found = objects.get(name)
        return found ? { bytes: found.bytes.slice(), version: found.version } : null
      }
    }
  }

  async write(name: string, bytes: Uint8Array, expected: string | null): Promise<string> {
    this.guard(name)
    if ((this.objects.get(name)?.version ?? null) !== expected) throw new StoreConflictError()
    const stored = { bytes: bytes.slice(), version: contentVersion(bytes) }
    this.objects.set(name, stored)
    return stored.version
  }

  async cleanUp(): Promise<void> {
    this.guard()
  }
}
