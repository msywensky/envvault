/** A FIFO queue: each call runs only after every earlier call has settled. */
export function createSerial(): <T>(fn: () => Promise<T>) => Promise<T> {
  let chain: Promise<unknown> = Promise.resolve()
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn)
    chain = run.catch(() => undefined)
    return run
  }
}

/**
 * Serialises every operation that writes files or changes the session
 * (create/unlock, push, pull, .gitignore edits, folder changes). Not
 * re-entrant: never call exclusive() from inside an exclusive() callback.
 */
export const exclusive = createSerial()
