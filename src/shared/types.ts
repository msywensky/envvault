// Plain data types shared by main, core and the renderer. Type-only, so the
// renderer can import them without pulling in node code.

export type SyncStatus =
  'vault-only' | 'no-env' | 'local-only' | 'vault-newer' | 'in-sync' | 'local-newer' | 'conflict'

/** Metadata about the vault copy of one repo. No values. */
export interface VaultInfo {
  version: number
  contentHash: string
  updatedBy: string
  updatedAt: string
}

/** What this machine last pushed or pulled for one repo. */
export interface LastSync {
  version: number
  contentHash: string
}

/** Key-name diff. Never contains values. */
export interface DiffResult {
  added: string[]
  removed: string[]
  changed: string[]
  unchanged: number
}
