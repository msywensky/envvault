// A VaultStore in memory: the reference implementation of the contract in
// types.ts, used by the tests. Settings never selects it.
import { checkName, StoreExistsError, type VaultStore } from './types'

export class MemoryStore implements VaultStore {
  private readonly objects = new Map<string, Uint8Array>()
  private readonly isReachable: boolean

  /** `reachable: false` behaves like a vault folder that doesn't exist. */
  constructor(opts: { reachable?: boolean } = {}) {
    this.isReachable = opts.reachable ?? true
  }

  private check(name?: string): void {
    if (!this.isReachable) throw new Error('The store is not reachable.')
    if (name !== undefined) checkName(name)
  }

  async reachable(): Promise<boolean> {
    return this.isReachable
  }

  async list(): Promise<string[]> {
    this.check()
    return [...this.objects.keys()]
  }

  // Copies in and out: callers wipe their buffers.
  async get(name: string): Promise<Uint8Array | null> {
    this.check(name)
    return this.objects.get(name)?.slice() ?? null
  }

  // Check and insert in one synchronous step, so racing creates have one winner.
  async create(name: string, bytes: Uint8Array): Promise<void> {
    this.check(name)
    if (this.objects.has(name)) throw new StoreExistsError()
    this.objects.set(name, bytes.slice())
  }

  async put(name: string, bytes: Uint8Array): Promise<void> {
    this.check(name)
    this.objects.set(name, bytes.slice())
  }

  async cleanUp(): Promise<void> {
    this.check()
  }
}
