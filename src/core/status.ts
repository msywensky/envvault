import type { LastSync, SyncStatus, VaultInfo } from '../shared/types'

export interface StatusInput {
  /** The repo folder was found in the projects scan. */
  repoExists: boolean
  /**
   * sha256 of the local .env bytes as a push would upload them (values of
   * machine-specific keys blanked), or null if there is no .env.
   */
  localHash: string | null
  vault: VaultInfo | null
  last: LastSync | null
}

/**
 * Three-way sync status. Rows are evaluated top to bottom; anything that
 * isn't clearly one-sided is a conflict, including a vault version lower than
 * the one last synced (possible rollback).
 */
export function computeStatus({ repoExists, localHash, vault, last }: StatusInput): SyncStatus {
  if (!repoExists) return vault ? 'vault-only' : 'no-env'
  if (localHash === null && vault === null) return 'no-env'
  if (vault === null) return 'local-only'
  // Checked before the no-local-file case too, so a rollback is never
  // offered as a one-click pull.
  const rolledBack = last !== null && vault.version < last.version
  if (localHash === null) return rolledBack ? 'conflict' : 'vault-newer'
  if (localHash === vault.contentHash) return 'in-sync'
  if (last === null) return 'conflict'
  const vaultUnchanged = vault.version === last.version && vault.contentHash === last.contentHash
  const localUnchanged = localHash === last.contentHash
  if (!localUnchanged && vaultUnchanged) return 'local-newer'
  if (localUnchanged && vault.version > last.version) return 'vault-newer'
  return 'conflict'
}

/**
 * Pushing must be confirmed whenever the vault copy is not exactly what this
 * machine last synced: someone else changed it, or we never synced it here.
 */
export function needsOverwriteConfirm(vault: VaultInfo | null, last: LastSync | null): boolean {
  if (vault === null) return false
  if (last === null) return true
  return vault.version !== last.version || vault.contentHash !== last.contentHash
}

/** The version number for the next push. Never goes backwards. */
export function nextVersion(vault: VaultInfo | null, last: LastSync | null): number {
  return Math.max(vault?.version ?? 0, last?.version ?? 0) + 1
}
