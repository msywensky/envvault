// Setup codes (src/core/setupcode.ts): a vault secret written for people.
import { describe, expect, it } from 'vitest'
import { randomSecret } from '../src/core/crypto'
import { formatSetupCode, parseSetupCode, SetupCodeError } from '../src/core/setupcode'

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex')

const refusal = (code: string): string => {
  try {
    parseSetupCode(code)
  } catch (err) {
    if (err instanceof SetupCodeError) return err.message
    throw err
  }
  return 'accepted'
}

describe('setup codes', () => {
  it('round-trips, in the documented shape', async () => {
    for (let i = 0; i < 50; i++) {
      const secret = await randomSecret()
      const code = formatSetupCode(secret)
      expect(code).toMatch(/^EV(-[0-9A-HJKMNP-TV-Z]{5}){5}-[0-9A-HJKMNP-TV-Z]{4}$/)
      expect(hex(parseSetupCode(code))).toBe(hex(secret))
    }
  })

  it('keeps a fixed encoding (checked against an independent implementation)', () => {
    const secret = Uint8Array.from({ length: 16 }, (_, i) => i * 17)
    expect(formatSetupCode(secret)).toBe('EV-008J4-CT4AN-K7F24-SNAXW-SQFEZ-Z842')
    expect(hex(parseSetupCode('EV-008J4-CT4AN-K7F24-SNAXW-SQFEZ-Z842'))).toBe(hex(secret))
  })

  it('forgives case, spaces, dashes, a missing prefix and look-alike letters', async () => {
    const secret = await randomSecret()
    const code = formatSetupCode(secret)
    const bare = code.slice(3).replace(/-/g, '')
    const lookAlikes = code.replace(/0/g, 'O').replace(/1/g, 'l')
    for (const typed of [
      code.toLowerCase(),
      ` ${code.replace(/-/g, ' ')} `,
      bare,
      bare.match(/.{1,4}/g)?.join(' ') ?? '',
      lookAlikes,
      `ev${bare}`
    ]) {
      expect(hex(parseSetupCode(typed)), typed).toBe(hex(secret))
    }
  })

  it('catches typos with its checksum', async () => {
    const code = formatSetupCode(await randomSecret())
    let caught = 0
    // Change each character in turn to another valid one.
    for (let i = 3; i < code.length; i++) {
      if (code[i] === '-') continue
      const swapped = code[i] === 'Z' ? 'Y' : 'Z'
      const typo = code.slice(0, i) + swapped + code.slice(i + 1)
      if (refusal(typo) !== 'accepted') caught++
    }
    expect(caught).toBe(29)
  })

  it('refuses anything else without quoting it', () => {
    for (const code of [
      '',
      'EV-',
      'not a setup code',
      'EV-00000-00000-00000-00000-00000-000',
      'EV-00000-00000-00000-00000-00000-00000',
      'EV-UUUUU-UUUUU-UUUUU-UUUUU-UUUUU-UUUU',
      'SECRET'.repeat(30)
    ]) {
      const message = refusal(code)
      expect(message, code).not.toBe('accepted')
      expect(message).not.toContain('SECRET')
      expect(message).not.toContain('not a setup')
    }
  })

  it('only writes 16-byte secrets', () => {
    expect(() => formatSetupCode(new Uint8Array(15))).toThrow()
  })
})
