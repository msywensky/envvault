// Runs Argon2id off the main thread. One job per worker. When the worker
// exits, its 256 MiB+ WASM heap (which libsodium frees without wiping, so
// it may still hold a copy of the key) is released.
import { parentPort, workerData } from 'node:worker_threads'
import { deriveKey } from '../core/crypto'
import type { KdfJob } from './kdf'

const job = workerData as KdfJob

deriveKey(job.password, job.salt, job.kdf)
  .then((key) => {
    // Transfer rather than copy, so this thread keeps no JS-side copy.
    parentPort?.postMessage(key, [key.buffer as ArrayBuffer])
  })
  .catch((err: unknown) => {
    parentPort?.postMessage({ error: err instanceof Error ? err.name : 'Error' })
  })
