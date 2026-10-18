// The storage behind the vault. vault.ts holds all the policy (meta.json,
// the KDF, entry names, decryption); a store only moves opaque bytes by
// name: encrypted entries and the plaintext meta.json, never a key or a
// value (lint keeps stores from importing anything that holds one).
//
// Reads go through a snapshot, and every write is a compare-and-swap
// against a version from one: it succeeds only if the object is still the
// one that was read. Versions are opaque strings (a hash of the bytes, or a
// git object id).
import { createHash } from 'node:crypto'

/** One name segment, lowercase like entry ids: "meta.json", "web.env.enc". */
export const STORE_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/

export interface VaultStore {
  readonly kind: 'folder' | 'git' | 'memory'
  /** The store can be used (the folder exists). Never throws. */
  reachable(): Promise<boolean>
  /** Throw an AppError if the store mustn't be used now. Called before create and open. */
  check(): Promise<void>
  /** A read view. How consistent it is depends on the store (see each one). */
  snapshot(): Promise<StoreSnapshot>
  /**
   * Write an object if it is still at `expected` (a version from a snapshot,
   * or null for "there is none"), otherwise StoreConflictError. Readers see
   * the old bytes or the new, never a mix. Of racing writes with the same
   * `expected`, exactly one wins. Returns the new version.
   */
  write(name: string, bytes: Uint8Array, expected: string | null): Promise<string>
  /** Remove leftovers of interrupted writes. Called after unlock; failures are ignored. */
  cleanUp(): Promise<void>
}

export interface StoreSnapshot {
  /** Names of the objects get() can read, without the store's own internals (temp files). */
  readonly names: string[]
  /** An object's bytes and version, or null if there is none. */
  get(name: string): Promise<StoreObject | null>
}

export interface StoreObject {
  bytes: Uint8Array
  version: string
}

export class StoreConflictError extends Error {
  constructor() {
    super('That object is not at the expected version.')
    this.name = 'StoreConflictError'
  }
}

export class StoreNameError extends Error {
  constructor() {
    super('Not a valid store name.')
    this.name = 'StoreNameError'
  }
}

/** The version of an object in a store that has no versions of its own: a hash of its bytes. */
export const contentVersion = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex')

/** Windows strips a trailing dot, so "a." would name the same file as "a". */
export const isStoreName = (name: string): boolean =>
  STORE_NAME_RE.test(name) && !name.endsWith('.')

/** For the start of every method that takes a name. */
export function checkName(name: string): void {
  if (!isStoreName(name)) throw new StoreNameError()
}
