import { describe, expect, it } from 'vitest'
import {
  KDF_DEFAULTS,
  KDF_MAX,
  MetaInvalidError,
  VaultTamperError,
  decodeEnv,
  decryptPayload,
  deriveKey,
  encryptPayload,
  makeKeyCheck,
  makePayload,
  parseMeta,
  randomSalt,
  serializeMeta,
  sha256Hex,
  verifyKeyCheck,
  zero,
  type KdfParams
} from '../src/core/crypto'

// Small parameters keep the suite fast. Production floors are tested below.
const FAST: KdfParams = { opslimit: 1, memlimit: 8 * 1024 * 1024 }
const enc = new TextEncoder()

async function key(password = 'correct horse', salt?: Uint8Array): Promise<Uint8Array> {
  return deriveKey(password, salt ?? (await randomSalt()), FAST)
}

const sample = (): Uint8Array => enc.encode('# comment\r\nA=1\nSECRET="s3cr3t value"\n')

describe('deriveKey', () => {
  it('is deterministic for the same password and salt', async () => {
    const salt = await randomSalt()
    expect(await key('pw', salt)).toEqual(await key('pw', salt))
  })

  it('differs for a different salt or password', async () => {
    const salt = await randomSalt()
    const k = await key('pw', salt)
    expect(await key('pw2', salt)).not.toEqual(k)
    expect(await key('pw', await randomSalt())).not.toEqual(k)
  })

  it('normalises Unicode so composed and decomposed input match', async () => {
    const salt = await randomSalt()
    expect(await key('café', salt)).toEqual(await key('café', salt))
  })

  it('rejects a salt of the wrong length', async () => {
    await expect(deriveKey('pw', new Uint8Array(8), FAST)).rejects.toThrow()
  })

  it(
    'works with the production parameters (WASM can allocate 256 MiB)',
    { timeout: 30_000 },
    async () => {
      const k = await deriveKey('pw', await randomSalt(), KDF_DEFAULTS)
      expect(k).toHaveLength(32)
    }
  )

  it(
    'works at the largest parameters meta.json may ask for (1 GiB)',
    { timeout: 60_000 },
    async () => {
      const k = await deriveKey('pw', await randomSalt(), KDF_MAX)
      expect(k).toHaveLength(32)
    }
  )
})

describe('encryptPayload / decryptPayload', () => {
  it('round-trips the exact bytes, including CRLF', async () => {
    const k = await key()
    const env = sample()
    const payload = makePayload(env, 1, 'laptop')
    const out = await decryptPayload(k, 'repo-a', await encryptPayload(k, 'repo-a', payload))
    expect(out).toEqual(payload)
    expect(new Uint8Array(decodeEnv(out))).toEqual(env)
    expect(out.contentHash).toBe(sha256Hex(env))
  })

  it('round-trips bytes that are not valid UTF-8', async () => {
    const k = await key()
    const env = Uint8Array.from([0xef, 0xbb, 0xbf, 0x41, 0x3d, 0xff, 0xfe, 0x0a])
    const out = await decryptPayload(k, 'r', await encryptPayload(k, 'r', makePayload(env, 1, 'm')))
    expect(new Uint8Array(decodeEnv(out))).toEqual(env)
  })

  it('uses a fresh nonce every time', async () => {
    const k = await key()
    const payload = makePayload(sample(), 1, 'm')
    const a = await encryptPayload(k, 'r', payload)
    const b = await encryptPayload(k, 'r', payload)
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false)
  })

  it('never contains the plaintext', async () => {
    const k = await key()
    const bytes = await encryptPayload(k, 'r', makePayload(sample(), 1, 'm'))
    expect(Buffer.from(bytes).includes('s3cr3t')).toBe(false)
  })

  it('rejects a flipped byte anywhere in the file', async () => {
    const k = await key()
    const bytes = await encryptPayload(k, 'r', makePayload(sample(), 1, 'm'))
    for (const i of [0, 4, 20, 28, bytes.length - 1]) {
      const bad = bytes.slice()
      bad[i] = (bad[i] ?? 0) ^ 0x01
      await expect(decryptPayload(k, 'r', bad)).rejects.toBeInstanceOf(VaultTamperError)
    }
  })

  it('rejects truncated files and wrong magic', async () => {
    const k = await key()
    const bytes = await encryptPayload(k, 'r', makePayload(sample(), 1, 'm'))
    await expect(decryptPayload(k, 'r', bytes.slice(0, 30))).rejects.toBeInstanceOf(
      VaultTamperError
    )
    await expect(decryptPayload(k, 'r', new Uint8Array())).rejects.toBeInstanceOf(VaultTamperError)
    const wrongMagic = bytes.slice()
    wrongMagic.set(enc.encode('XXXX'), 0)
    await expect(decryptPayload(k, 'r', wrongMagic)).rejects.toThrow('Not an EnvVault file.')
  })

  it('rejects the wrong key', async () => {
    const bytes = await encryptPayload(await key('a'), 'r', makePayload(sample(), 1, 'm'))
    await expect(decryptPayload(await key('b'), 'r', bytes)).rejects.toBeInstanceOf(
      VaultTamperError
    )
  })

  it("binds the repo name: a's file can't be read as b's", async () => {
    const k = await key()
    const bytes = await encryptPayload(k, 'repo-a', makePayload(sample(), 1, 'm'))
    await expect(decryptPayload(k, 'repo-b', bytes)).rejects.toBeInstanceOf(VaultTamperError)
  })

  it('rejects a payload whose hash does not match its content', async () => {
    const k = await key()
    const payload = { ...makePayload(sample(), 1, 'm'), contentHash: 'a'.repeat(64) }
    const bytes = await encryptPayload(k, 'r', payload)
    await expect(decryptPayload(k, 'r', bytes)).rejects.toThrow('hash does not match')
  })

  it('rejects a payload that fails schema validation', async () => {
    const k = await key()
    const payload = { ...makePayload(sample(), 1, 'm'), version: 0 }
    const bytes = await encryptPayload(k, 'r', payload)
    await expect(decryptPayload(k, 'r', bytes)).rejects.toThrow('malformed')
  })
})

describe('key check', () => {
  const VAULT_ID = '3f1c2b8e-5d4a-4c3b-9a2e-1f0e9d8c7b6a'

  it('verifies with the right key only', async () => {
    const salt = await randomSalt()
    const right = await key('pw', salt)
    const check = await makeKeyCheck(right, VAULT_ID)
    expect(await verifyKeyCheck(right, VAULT_ID, check)).toBe(true)
    expect(await verifyKeyCheck(await key('nope', salt), VAULT_ID, check)).toBe(false)
  })

  it('fails if the vaultId in meta.json was edited', async () => {
    const k = await key()
    const check = await makeKeyCheck(k, VAULT_ID)
    expect(await verifyKeyCheck(k, '00000000-0000-4000-8000-000000000000', check)).toBe(false)
  })

  it('returns false for garbage instead of throwing', async () => {
    expect(await verifyKeyCheck(await key(), VAULT_ID, 'AAAA')).toBe(false)
  })
})

describe('zero', () => {
  it('overwrites key material', async () => {
    const k = await key()
    await zero(k)
    expect(k.every((b) => b === 0)).toBe(true)
  })
})

describe('parseMeta', () => {
  async function validMeta(): Promise<Record<string, unknown>> {
    const salt = await randomSalt()
    const vaultId = '3f1c2b8e-5d4a-4c3b-9a2e-1f0e9d8c7b6a'
    return serializeMeta({
      vaultId,
      kdf: { ...KDF_DEFAULTS },
      salt,
      keyCheck: await makeKeyCheck(await key('pw', salt), vaultId)
    }) as unknown as Record<string, unknown>
  }
  const withKdf = (m: Record<string, unknown>, patch: Record<string, unknown>): unknown => ({
    ...m,
    kdf: { ...(m['kdf'] as object), ...patch }
  })

  it('accepts what serializeMeta writes', async () => {
    const meta = parseMeta(await validMeta())
    expect(meta.kdf).toEqual(KDF_DEFAULTS)
    expect(meta.salt).toHaveLength(16)
  })

  it('rejects weak KDF parameters (downgrade attack)', async () => {
    const m = await validMeta()
    expect(() => parseMeta(withKdf(m, { opslimit: 2 }))).toThrow(MetaInvalidError)
    expect(() => parseMeta(withKdf(m, { memlimit: 64 * 1024 * 1024 }))).toThrow(MetaInvalidError)
  })

  it('accepts parameters up to KDF_MAX and rejects anything beyond (denial of service)', async () => {
    const m = await validMeta()
    expect(parseMeta(withKdf(m, { ...KDF_MAX })).kdf).toEqual(KDF_MAX)
    expect(() => parseMeta(withKdf(m, { opslimit: KDF_MAX.opslimit + 1 }))).toThrow(
      MetaInvalidError
    )
    expect(() => parseMeta(withKdf(m, { memlimit: KDF_MAX.memlimit + 1 }))).toThrow(
      MetaInvalidError
    )
    expect(() => parseMeta(withKdf(m, { memlimit: 4 * 1024 ** 3 }))).toThrow(MetaInvalidError)
  })

  it('rejects a bad salt, unknown fields and wrong types', async () => {
    const m = await validMeta()
    expect(() => parseMeta(withKdf(m, { salt: 'AAAA' }))).toThrow('16 bytes')
    expect(() => parseMeta({ ...m, extra: 1 })).toThrow(MetaInvalidError)
    expect(() => parseMeta(withKdf(m, { alg: 'scrypt' }))).toThrow(MetaInvalidError)
    expect(() => parseMeta({ ...m, formatVersion: 2 })).toThrow(MetaInvalidError)
    expect(() => parseMeta({ ...m, vaultId: 'not-a-uuid' })).toThrow(MetaInvalidError)
    expect(() => parseMeta(null)).toThrow(MetaInvalidError)
  })
})
