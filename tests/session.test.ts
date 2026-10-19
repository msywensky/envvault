// The idle auto-lock: it locks after the set minutes without activity, and
// never when it's off (null).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let session: typeof import('../src/main/session')

beforeEach(async () => {
  vi.useFakeTimers()
  vi.resetModules()
  session = await import('../src/main/session')
})
afterEach(() => vi.useRealTimers())

const MINUTE = 60_000
const key = (): Uint8Array => new Uint8Array(32).fill(7)

describe('auto-lock', () => {
  it('locks after the idle minutes, and activity postpones it', () => {
    const locked = vi.fn()
    session.onLocked(locked)
    session.unlock(key(), 'v', 5)
    vi.advanceTimersByTime(4 * MINUTE)
    session.touch()
    vi.advanceTimersByTime(4 * MINUTE)
    expect(session.isUnlocked()).toBe(true)
    vi.advanceTimersByTime(MINUTE)
    expect(session.isUnlocked()).toBe(false)
    expect(locked).toHaveBeenCalledOnce()
  })

  it('never locks on its own when off', () => {
    session.unlock(key(), 'v', null)
    vi.advanceTimersByTime(24 * 60 * MINUTE)
    expect(session.isUnlocked()).toBe(true)
    session.lock()
    expect(session.isUnlocked()).toBe(false)
  })

  it('applies a change of setting while unlocked', () => {
    session.unlock(key(), 'v', 5)
    session.setAutoLockMinutes(null)
    vi.advanceTimersByTime(60 * MINUTE)
    expect(session.isUnlocked()).toBe(true)

    session.setAutoLockMinutes(2)
    vi.advanceTimersByTime(2 * MINUTE)
    expect(session.isUnlocked()).toBe(false)
  })

  it('wipes the key when it locks', () => {
    const k = key()
    session.unlock(k, 'v', 1)
    vi.advanceTimersByTime(MINUTE)
    expect(k.every((b) => b === 0)).toBe(true)
  })
})
