// Holds the derived vault key while unlocked, and the idle auto-lock timer.
import { AppError } from './errors'

let key: Uint8Array | null = null
let vaultId: string | null = null
let timer: NodeJS.Timeout | null = null
/** null: auto-lock is off, so only Lock, sleep, a screen lock or closing the window locks. */
let idleMs: number | null = 5 * 60_000
const listeners = new Set<() => void>()

export function onLocked(fn: () => void): void {
  listeners.add(fn)
}

export function isUnlocked(): boolean {
  return key !== null
}

export function unlock(
  newKey: Uint8Array,
  newVaultId: string,
  autoLockMinutes: number | null
): void {
  if (key) key.fill(0)
  key = newKey
  vaultId = newVaultId
  idleMs = autoLockMinutes === null ? null : autoLockMinutes * 60_000
  touch()
}

/**
 * Wipe the key and (unless told not to) notify the renderer. Safe to call
 * when already locked.
 */
export function lock(opts: { notify?: boolean } = {}): void {
  if (timer) clearTimeout(timer)
  timer = null
  const wasUnlocked = key !== null
  if (key) key.fill(0)
  key = null
  vaultId = null
  if (wasUnlocked && opts.notify !== false) notifyLocked()
}

export function notifyLocked(): void {
  for (const fn of listeners) fn()
}

/** Reset the idle timer. Called on every authorised IPC request. */
export function touch(): void {
  if (!key) return
  if (timer) clearTimeout(timer)
  timer = idleMs === null ? null : setTimeout(() => lock(), idleMs)
}

/** Minutes idle before locking, or null for never. */
export function setAutoLockMinutes(minutes: number | null): void {
  idleMs = minutes === null ? null : minutes * 60_000
  touch()
}

/**
 * Run `fn` with a private copy of the key, wiped afterwards. Locking while
 * `fn` runs wipes only the session's copy, so an operation in flight can
 * never encrypt with an all-zero key.
 */
export async function withKey<T>(fn: (key: Uint8Array, vaultId: string) => Promise<T>): Promise<T> {
  if (!key || !vaultId) throw new AppError('LOCKED', 'The vault is locked.')
  const copy = key.slice()
  try {
    return await fn(copy, vaultId)
  } finally {
    copy.fill(0)
  }
}
