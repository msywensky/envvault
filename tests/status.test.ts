import { describe, expect, it } from 'vitest'
import { computeStatus, needsOverwriteConfirm, nextVersion } from '../src/core/status'
import type { LastSync, VaultInfo } from '../src/shared/types'

const H1 = '1'.repeat(64)
const H2 = '2'.repeat(64)
const H3 = '3'.repeat(64)
const vault = (version: number, contentHash: string): VaultInfo => ({
  version,
  contentHash,
  updatedBy: 'desktop',
  updatedAt: '2026-10-16T12:00:00.000Z'
})
const last = (version: number, contentHash: string): LastSync => ({ version, contentHash })

describe('computeStatus (one test per table row)', () => {
  it('vault only: repo not in scan, vault file exists', () => {
    expect(
      computeStatus({ repoExists: false, localHash: null, vault: vault(1, H1), last: null })
    ).toBe('vault-only')
  })

  it('no .env: no local file, nothing in the vault', () => {
    expect(computeStatus({ repoExists: true, localHash: null, vault: null, last: null })).toBe(
      'no-env'
    )
  })

  it('local only: local .env, nothing in the vault', () => {
    expect(computeStatus({ repoExists: true, localHash: H1, vault: null, last: null })).toBe(
      'local-only'
    )
    // Even if we synced before (vault file deleted since).
    expect(computeStatus({ repoExists: true, localHash: H1, vault: null, last: last(3, H1) })).toBe(
      'local-only'
    )
  })

  it('vault newer: no local .env, vault exists', () => {
    expect(
      computeStatus({ repoExists: true, localHash: null, vault: vault(2, H1), last: null })
    ).toBe('vault-newer')
  })

  it('in sync: hashes match (regardless of last)', () => {
    expect(
      computeStatus({ repoExists: true, localHash: H1, vault: vault(2, H1), last: null })
    ).toBe('in-sync')
    expect(
      computeStatus({ repoExists: true, localHash: H1, vault: vault(5, H1), last: last(2, H2) })
    ).toBe('in-sync')
  })

  it('conflict: differ and never synced here', () => {
    expect(
      computeStatus({ repoExists: true, localHash: H1, vault: vault(1, H2), last: null })
    ).toBe('conflict')
  })

  it('local newer: only local changed since last sync', () => {
    expect(
      computeStatus({ repoExists: true, localHash: H2, vault: vault(3, H1), last: last(3, H1) })
    ).toBe('local-newer')
  })

  it('vault newer: only the vault changed since last sync', () => {
    expect(
      computeStatus({ repoExists: true, localHash: H1, vault: vault(4, H2), last: last(3, H1) })
    ).toBe('vault-newer')
  })

  it('conflict: both changed', () => {
    expect(
      computeStatus({ repoExists: true, localHash: H3, vault: vault(4, H2), last: last(3, H1) })
    ).toBe('conflict')
  })

  it('conflict: vault version went backwards (possible rollback)', () => {
    expect(
      computeStatus({ repoExists: true, localHash: H1, vault: vault(2, H2), last: last(3, H1) })
    ).toBe('conflict')
    expect(
      computeStatus({ repoExists: true, localHash: H3, vault: vault(2, H2), last: last(3, H1) })
    ).toBe('conflict')
    // Also with no local .env: never offer a rollback as a one-click pull.
    expect(
      computeStatus({ repoExists: true, localHash: null, vault: vault(2, H2), last: last(5, H1) })
    ).toBe('conflict')
    // A deleted local .env with an unchanged vault is still a simple pull.
    expect(
      computeStatus({ repoExists: true, localHash: null, vault: vault(5, H1), last: last(5, H1) })
    ).toBe('vault-newer')
  })

  it('conflict: same version but different vault content (concurrent push)', () => {
    // Another machine also pushed version 4; Drive kept theirs.
    expect(
      computeStatus({ repoExists: true, localHash: H1, vault: vault(4, H2), last: last(4, H1) })
    ).toBe('conflict')
    // Local edited too: must not be "local newer", or a push would silently drop theirs.
    expect(
      computeStatus({ repoExists: true, localHash: H3, vault: vault(4, H2), last: last(4, H1) })
    ).toBe('conflict')
  })
})

describe('needsOverwriteConfirm', () => {
  it('is false when there is no vault copy', () => {
    expect(needsOverwriteConfirm(null, null)).toBe(false)
    expect(needsOverwriteConfirm(null, last(2, H1))).toBe(false)
  })

  it('is false when the vault is exactly what we last synced', () => {
    expect(needsOverwriteConfirm(vault(3, H1), last(3, H1))).toBe(false)
  })

  it('is true when we never synced here', () => {
    expect(needsOverwriteConfirm(vault(1, H1), null)).toBe(true)
  })

  it('is true when the vault moved on, went back, or was rewritten', () => {
    expect(needsOverwriteConfirm(vault(4, H2), last(3, H1))).toBe(true)
    expect(needsOverwriteConfirm(vault(2, H2), last(3, H1))).toBe(true)
    expect(needsOverwriteConfirm(vault(3, H2), last(3, H1))).toBe(true)
  })
})

describe('nextVersion', () => {
  it('increments past both the vault and the last-synced version', () => {
    expect(nextVersion(null, null)).toBe(1)
    expect(nextVersion(vault(4, H1), last(3, H1))).toBe(5)
    // Vault file deleted: don't restart at 1, or other machines see a rollback.
    expect(nextVersion(null, last(7, H1))).toBe(8)
    expect(nextVersion(vault(2, H1), last(7, H1))).toBe(8)
  })
})
