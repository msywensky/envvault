// Setup codes: a format 2 vault's secret (crypto.ts, SECRET_BYTES) written
// out for a person to copy into a password manager and type on another
// machine. 16 secret bytes and a 2-byte checksum in Crockford base32:
//   EV-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXX
// Reading one forgives case, spaces, dashes and the look-alikes O (0) and
// I or L (1). Errors are fixed strings that never quote the input.
import { createHash } from 'node:crypto'
import { SECRET_BYTES } from './crypto'

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const CHECK_BYTES = 2
const PREFIX = 'EV'
// (16 + 2) bytes = 144 bits = 29 base32 characters (the last holds 4 bits).
const CODE_CHARS = Math.ceil(((SECRET_BYTES + CHECK_BYTES) * 8) / 5)
const GROUPS = [5, 5, 5, 5, 5, 4]

export class SetupCodeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SetupCodeError'
  }
}

const checksum = (secret: Uint8Array): Buffer =>
  createHash('sha256')
    .update('envvault-setup-code')
    .update(secret)
    .digest()
    .subarray(0, CHECK_BYTES)

export function formatSetupCode(secret: Uint8Array): string {
  if (secret.length !== SECRET_BYTES) throw new Error('The vault secret must be 16 bytes.')
  const bytes = Buffer.concat([secret, checksum(secret)])
  let bits = 0
  let value = 0
  let chars = ''
  for (const byte of bytes) {
    value = ((value << 8) | byte) & 0xffff
    bits += 8
    while (bits >= 5) {
      chars += ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) chars += ALPHABET[(value << (5 - bits)) & 31]
  bytes.fill(0)
  const groups: string[] = []
  let at = 0
  for (const size of GROUPS) {
    groups.push(chars.slice(at, at + size))
    at += size
  }
  return [PREFIX, ...groups].join('-')
}

/** The secret in a setup code. Throws SetupCodeError if it isn't a valid one. */
export function parseSetupCode(code: string): Uint8Array {
  if (code.length > 100) throw malformed()
  let chars = code.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1')
  if (chars.length === CODE_CHARS + PREFIX.length && chars.startsWith(PREFIX)) {
    chars = chars.slice(PREFIX.length)
  }
  if (chars.length !== CODE_CHARS) throw malformed()
  const bytes = Buffer.alloc(SECRET_BYTES + CHECK_BYTES)
  let bits = 0
  let value = 0
  let at = 0
  for (const char of chars) {
    const digit = ALPHABET.indexOf(char)
    if (digit === -1) throw malformed()
    value = ((value << 5) | digit) & 0xfff
    bits += 5
    if (bits >= 8) {
      bytes[at++] = (value >>> (bits - 8)) & 0xff
      bits -= 8
    }
  }
  // The last character's spare bit is always 0 in a code we wrote.
  if ((value & ((1 << bits) - 1)) !== 0) throw mistyped()
  const secret = new Uint8Array(bytes.subarray(0, SECRET_BYTES))
  const ok = checksum(secret).equals(bytes.subarray(SECRET_BYTES))
  bytes.fill(0)
  if (!ok) {
    secret.fill(0)
    throw mistyped()
  }
  return secret
}

const malformed = (): SetupCodeError =>
  new SetupCodeError('A setup code looks like EV-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXX.')
const mistyped = (): SetupCodeError =>
  new SetupCodeError('That setup code has a typo. Check it and try again.')
