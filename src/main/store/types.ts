// The storage behind the vault. vault.ts holds all the policy (meta.json,
// the KDF, entry names, decryption); a store only moves opaque bytes by
// name: encrypted entries and the plaintext meta.json, never a key or a
// value (lint keeps stores from importing anything that holds one).

/** One name segment, lowercase like entry ids: "meta.json", "web.env.enc". */
export const STORE_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/

export interface VaultStore {
  /** The store can be used (the folder exists). Never throws. */
  reachable(): Promise<boolean>
  /** Names of the objects get() can read, without the store's own internals (temp files). */
  list(): Promise<string[]>
  /** An object's bytes, or null if there is none. */
  get(name: string): Promise<Uint8Array | null>
  /** Create an object, or StoreExistsError if one exists. Of racing creates, exactly one wins. */
  create(name: string, bytes: Uint8Array): Promise<void>
  /** Create or replace an object atomically: readers see the old bytes or the new, never a mix. */
  put(name: string, bytes: Uint8Array): Promise<void>
  /** Remove leftovers of interrupted writes. Called after unlock; failures are ignored. */
  cleanUp(): Promise<void>
}

export class StoreExistsError extends Error {
  constructor() {
    super('That object already exists.')
    this.name = 'StoreExistsError'
  }
}

export class StoreNameError extends Error {
  constructor() {
    super('Not a valid store name.')
    this.name = 'StoreNameError'
  }
}

/** Windows strips a trailing dot, so "a." would name the same file as "a". */
export const isStoreName = (name: string): boolean =>
  STORE_NAME_RE.test(name) && !name.endsWith('.')

/** For the start of every method that takes a name. */
export function checkName(name: string): void {
  if (!isStoreName(name)) throw new StoreNameError()
}
