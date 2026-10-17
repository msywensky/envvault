// Vault cryptography: Argon2id key derivation and XChaCha20-Poly1305 AEAD,
// both from libsodium (WASM build, no native modules).
//
// Pure logic: no electron, fs or child_process imports. Used by the main
// process, the KDF worker and the unit tests.
import sodium from 'libsodium-wrappers-sumo'
import { createHash } from 'node:crypto'
import { z } from 'zod'

/** A vault file failed authentication or validation. Never retry or "repair". */
export class VaultTamperError extends Error {
  constructor(message = 'Vault file failed authentication.') {
    super(message)
    this.name = 'VaultTamperError'
  }
}

/** meta.json is malformed or asks for weaker/unsafe KDF settings. */
export class MetaInvalidError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MetaInvalidError'
  }
}

export interface KdfParams {
  opslimit: number
  memlimit: number
}

const MiB = 1024 * 1024

/** libsodium's MODERATE preset. Also the minimum accepted from meta.json. */
export const KDF_DEFAULTS: Readonly<KdfParams> = { opslimit: 3, memlimit: 256 * MiB }
/**
 * libsodium's SENSITIVE preset, the most meta.json may ask for. Stops a
 * tampered meta.json from hanging or crashing the app (~3 s in WASM on a
 * modern desktop, well inside the worker's timeout).
 */
export const KDF_MAX: Readonly<KdfParams> = { opslimit: 4, memlimit: 1024 * MiB }

export const SALT_BYTES = 16
export const KEY_BYTES = 32
const NONCE_BYTES = 24
const TAG_BYTES = 16
const MAGIC = Uint8Array.from([0x45, 0x56, 0x56, 0x31]) // "EVV1"
const HEADER_BYTES = MAGIC.length + NONCE_BYTES

const KEYCHECK_PLAINTEXT = 'envvault-keycheck'
// Binding the vaultId authenticates it: an edited vaultId fails the check.
// (Salt and KDF params are bound implicitly, since they determine the key.)
const keyCheckAad = (vaultId: string): string => `envvault:keycheck:${vaultId}`
// Repo names are ASCII-only (isValidRepoName), so no normalisation is needed.
const entryAad = (repoName: string): string => `envvault:v1:${repoName}`

async function lib(): Promise<typeof sodium> {
  await sodium.ready
  return sodium
}

// ---------------------------------------------------------------------------
// Key derivation

/**
 * Derive the 32-byte vault key. Does NOT enforce minimum parameters (tests use
 * small ones); untrusted parameters must come through parseMeta().
 * The password is NFC-normalised so the same password typed on macOS and
 * Windows always derives the same key.
 */
export async function deriveKey(
  password: string,
  salt: Uint8Array,
  kdf: KdfParams
): Promise<Uint8Array> {
  const s = await lib()
  if (salt.length !== SALT_BYTES) throw new Error('Salt must be 16 bytes.')
  return s.crypto_pwhash(
    KEY_BYTES,
    password.normalize('NFC'),
    salt,
    kdf.opslimit,
    kdf.memlimit,
    s.crypto_pwhash_ALG_ARGON2ID13
  )
}

export async function randomSalt(): Promise<Uint8Array> {
  return (await lib()).randombytes_buf(SALT_BYTES)
}

/** Overwrite key material in place. */
export async function zero(buf: Uint8Array): Promise<void> {
  ;(await lib()).memzero(buf)
}

// ---------------------------------------------------------------------------
// AEAD file format: "EVV1" | 24-byte nonce | ciphertext+tag

async function seal(key: Uint8Array, aad: string, plaintext: Uint8Array): Promise<Uint8Array> {
  const s = await lib()
  const nonce = s.randombytes_buf(NONCE_BYTES)
  const ct = s.crypto_aead_xchacha20poly1305_ietf_encrypt(plaintext, aad, null, nonce, key)
  const out = new Uint8Array(HEADER_BYTES + ct.length)
  out.set(MAGIC, 0)
  out.set(nonce, MAGIC.length)
  out.set(ct, HEADER_BYTES)
  return out
}

async function open(key: Uint8Array, aad: string, bytes: Uint8Array): Promise<Uint8Array> {
  const s = await lib()
  if (bytes.length < HEADER_BYTES + TAG_BYTES)
    throw new VaultTamperError('Vault file is truncated.')
  for (let i = 0; i < MAGIC.length; i++) {
    if (bytes[i] !== MAGIC[i]) throw new VaultTamperError('Not an EnvVault file.')
  }
  const nonce = bytes.subarray(MAGIC.length, HEADER_BYTES)
  const ct = bytes.subarray(HEADER_BYTES)
  try {
    return s.crypto_aead_xchacha20poly1305_ietf_decrypt(null, ct, aad, nonce, key)
  } catch {
    throw new VaultTamperError()
  }
}

// ---------------------------------------------------------------------------
// Vault entries

const PayloadSchema = z.strictObject({
  version: z.int().min(1),
  updatedAt: z.iso.datetime(),
  updatedBy: z.string().min(1).max(200),
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),
  /** The .env bytes as pushed (machine-specific values blanked), base64-encoded. */
  envBase64: z.base64()
})

export type Payload = z.infer<typeof PayloadSchema>

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export function decodeEnv(payload: Payload): Buffer {
  return Buffer.from(payload.envBase64, 'base64')
}

/** Build a payload for the given .env bytes. */
export function makePayload(
  env: Uint8Array,
  version: number,
  updatedBy: string,
  now: Date = new Date()
): Payload {
  return {
    version,
    updatedAt: now.toISOString(),
    updatedBy,
    contentHash: sha256Hex(env),
    envBase64: Buffer.from(env).toString('base64')
  }
}

/**
 * Encrypt one repo's payload. The repo name is bound in as associated data,
 * so a file copied over another repo's file fails to decrypt.
 */
export async function encryptPayload(
  key: Uint8Array,
  repoName: string,
  payload: Payload
): Promise<Uint8Array> {
  const s = await lib()
  const plaintext = s.from_string(JSON.stringify(payload))
  try {
    return await seal(key, entryAad(repoName), plaintext)
  } finally {
    s.memzero(plaintext)
  }
}

/** Decrypt and validate. Every failure is a VaultTamperError. */
export async function decryptPayload(
  key: Uint8Array,
  repoName: string,
  bytes: Uint8Array
): Promise<Payload> {
  const s = await lib()
  const plaintext = await open(key, entryAad(repoName), bytes)
  let json: unknown
  try {
    json = JSON.parse(s.to_string(plaintext))
  } catch {
    throw new VaultTamperError('Vault file contents are malformed.')
  } finally {
    s.memzero(plaintext)
  }
  const parsed = PayloadSchema.safeParse(json)
  if (!parsed.success) throw new VaultTamperError('Vault file contents are malformed.')
  if (sha256Hex(decodeEnv(parsed.data)) !== parsed.data.contentHash) {
    throw new VaultTamperError('Vault file content hash does not match.')
  }
  return parsed.data
}

// ---------------------------------------------------------------------------
// Key check: proves the password is right before touching any entry, so a
// wrong password is reported as such and not as "tampered file".

export async function makeKeyCheck(key: Uint8Array, vaultId: string): Promise<string> {
  const s = await lib()
  const sealed = await seal(key, keyCheckAad(vaultId), s.from_string(KEYCHECK_PLAINTEXT))
  return Buffer.from(sealed).toString('base64')
}

export async function verifyKeyCheck(
  key: Uint8Array,
  vaultId: string,
  blobBase64: string
): Promise<boolean> {
  const s = await lib()
  try {
    const plaintext = await open(key, keyCheckAad(vaultId), Buffer.from(blobBase64, 'base64'))
    return s.to_string(plaintext) === KEYCHECK_PLAINTEXT
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// meta.json (plaintext, in the vault folder; treat as attacker-controlled)

const MetaSchema = z.strictObject({
  formatVersion: z.literal(1),
  vaultId: z.uuid(),
  kdf: z.strictObject({
    alg: z.literal('argon2id'),
    opslimit: z.int(),
    memlimit: z.int(),
    salt: z.base64()
  }),
  keyCheck: z.base64()
})

export type MetaJson = z.infer<typeof MetaSchema>

export interface Meta {
  vaultId: string
  kdf: KdfParams
  salt: Uint8Array
  keyCheck: string
}

/** The only way to read meta.json. Rejects weak, absurd or malformed settings. */
export function parseMeta(json: unknown): Meta {
  const parsed = MetaSchema.safeParse(json)
  if (!parsed.success) throw new MetaInvalidError('meta.json is malformed.')
  const { kdf, vaultId, keyCheck } = parsed.data
  assertKdfParams(kdf)
  const salt = Buffer.from(kdf.salt, 'base64')
  if (salt.length !== SALT_BYTES) throw new MetaInvalidError('meta.json salt must be 16 bytes.')
  return {
    vaultId,
    kdf: { opslimit: kdf.opslimit, memlimit: kdf.memlimit },
    salt: new Uint8Array(salt),
    keyCheck
  }
}

export function assertKdfParams(kdf: KdfParams): void {
  if (kdf.opslimit < KDF_DEFAULTS.opslimit || kdf.memlimit < KDF_DEFAULTS.memlimit) {
    throw new MetaInvalidError('meta.json asks for weaker key derivation than allowed.')
  }
  if (kdf.opslimit > KDF_MAX.opslimit || kdf.memlimit > KDF_MAX.memlimit) {
    throw new MetaInvalidError('meta.json asks for more key-derivation work than allowed.')
  }
}

export function serializeMeta(meta: Meta): MetaJson {
  return {
    formatVersion: 1,
    vaultId: meta.vaultId,
    kdf: {
      alg: 'argon2id',
      opslimit: meta.kdf.opslimit,
      memlimit: meta.kdf.memlimit,
      salt: Buffer.from(meta.salt).toString('base64')
    },
    keyCheck: meta.keyCheck
  }
}
