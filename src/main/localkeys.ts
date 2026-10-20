// Byte-level wrappers around core/localkeys for the push/pull flows: decode,
// apply, re-encode, and turn failures into AppErrors. Files without
// machine-specific keys pass through as the same buffer, untouched.
import {
  DuplicateLocalKeyError,
  keepLocal,
  mergePull,
  projectEnv,
  type LocalTakes
} from '../core/localkeys'
import { AppError } from './errors'

function duplicateKey(): AppError {
  return new AppError(
    'ENV_DUPLICATE_KEY',
    'A machine-specific key (# envvault:local) is assigned more than once, in .env or the vault copy. Remove the duplicate, then try again.'
  )
}

function apply<T>(fn: () => T): T {
  try {
    return fn()
  } catch (err) {
    if (err instanceof DuplicateLocalKeyError) throw duplicateKey()
    throw err
  }
}

/**
 * Refuse to edit `bytes` as `text` unless `text` encodes back to exactly
 * `bytes`: a .env that isn't valid UTF-8 would be silently altered.
 */
function requireUtf8(bytes: Buffer, text: string): void {
  const again = Buffer.from(text, 'utf8')
  try {
    if (!again.equals(bytes)) {
      throw new AppError(
        'ENV_NOT_UTF8',
        '.env is not valid UTF-8, so its machine-specific keys (# envvault:local) cannot be applied.'
      )
    }
  } finally {
    again.fill(0)
  }
}

/**
 * The bytes a push uploads and status hashes: `env` with the values of
 * machine-specific keys blanked (see projectEnv). `env` itself when nothing
 * is marked; otherwise a new buffer the caller must wipe.
 */
export function syncedBytes(env: Buffer): Buffer {
  const text = env.toString('utf8')
  const projected = apply(() => projectEnv(text))
  if (projected === null) return env
  requireUtf8(env, text)
  return Buffer.from(projected, 'utf8')
}

export interface Merged {
  /** The bytes a pull writes. The caller must wipe them. */
  bytes: Buffer
  kept: string[]
  unset: string[]
}

/**
 * What a pull writes: the vault copy with this machine's machine-specific
 * lines kept, and the keys in `takes` from the local file (see mergePull).
 * Takes ownership of `vault`: it is returned as `bytes` when nothing comes
 * from the local file, and wiped otherwise.
 */
export function mergedBytes(
  vault: Buffer,
  local: Buffer | null,
  takes: LocalTakes = new Map()
): Merged {
  let returned = false
  try {
    const vaultText = vault.toString('utf8')
    const localText = local?.toString('utf8') ?? null
    const { text, kept, unset } = apply(() => mergePull(vaultText, localText, takes))
    if (text === null) {
      returned = true
      return { bytes: vault, kept, unset }
    }
    requireUtf8(vault, vaultText)
    if (local && localText !== null) requireUtf8(local, localText)
    return { bytes: Buffer.from(text, 'utf8'), kept, unset }
  } finally {
    if (!returned) vault.fill(0)
  }
}

/**
 * What resolving writes when this machine's copy wins every key (see
 * keepLocal): a new buffer the caller must wipe. Takes ownership of `vault`
 * and wipes it.
 */
export function keptLocalBytes(vault: Buffer, local: Buffer, machine: Iterable<string>): Buffer {
  try {
    const vaultText = vault.toString('utf8')
    const localText = local.toString('utf8')
    const text = apply(() => keepLocal(vaultText, localText, machine))
    requireUtf8(local, localText)
    return Buffer.from(text, 'utf8')
  } finally {
    vault.fill(0)
  }
}
