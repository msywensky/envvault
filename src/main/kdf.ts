import { Worker } from 'node:worker_threads'
import { KEY_BYTES, type KdfParams } from '../core/crypto'
import workerPath from './kdf.worker?modulePath'

export interface KdfJob {
  password: string
  salt: Uint8Array
  kdf: KdfParams
}

// parseMeta caps the work at KDF_MAX (~3 s on a modern desktop), so this
// leaves a wide margin for slow laptops.
const TIMEOUT_MS = 60_000

/**
 * Derive the vault key in a short-lived worker thread. crypto_pwhash is
 * synchronous and, at 256 MiB, blocks for long enough that doing it on the
 * main thread would freeze the whole app.
 */
export function deriveKeyInWorker(job: KdfJob): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerPath, { workerData: job })
    let settled = false
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }
    const timer = setTimeout(() => {
      finish(() => reject(new Error('Key derivation timed out.')))
      void worker.terminate()
    }, TIMEOUT_MS)

    worker.once('message', (msg: unknown) => {
      if (msg instanceof Uint8Array && msg.length === KEY_BYTES) {
        // A key that arrives after the timeout fired is wiped, not leaked.
        if (settled) msg.fill(0)
        else finish(() => resolve(msg))
        return
      }
      const name =
        typeof msg === 'object' && msg !== null && 'error' in msg ? String(msg.error) : 'bad reply'
      finish(() => reject(new Error(`Key derivation failed (${name}).`)))
    })
    worker.once('error', (err) =>
      finish(() => reject(new Error(`Key derivation failed (${err.name}).`)))
    )
    // Messages are delivered before 'exit', so an exit while still unsettled
    // means the worker died without answering (for example, out of memory).
    worker.once('exit', (code) =>
      finish(() => reject(new Error(`Key derivation failed (worker exit ${code}).`)))
    )
  })
}
