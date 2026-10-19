/** A FIFO queue: each call runs only after every earlier call has settled. */
export function createSerial(): <T>(fn: () => Promise<T>) => Promise<T> {
  let chain: Promise<unknown> = Promise.resolve()
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn)
    chain = run.catch(() => undefined)
    return run
  }
}

/** Runs at most `n` calls at once; the rest wait their turn, first come first served. */
export function createLimit(n: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let running = 0
  const waiting: (() => void)[] = []
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (running < n) running++
    // A finishing call hands its slot straight to the next one waiting.
    else await new Promise<void>((resolve) => waiting.push(resolve))
    try {
      return await fn()
    } finally {
      const next = waiting.shift()
      if (next) next()
      else running--
    }
  }
}

/**
 * Serialises every operation that writes files or changes the session
 * (create/unlock, push, pull, .gitignore edits, folder changes). Not
 * re-entrant: never call exclusive() from inside an exclusive() callback.
 */
export const exclusive = createSerial()
