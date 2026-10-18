import { parse } from 'dotenv'
import { describe, expect, it } from 'vitest'
import {
  DuplicateKeyError,
  EditError,
  applyEdits,
  editorEntries,
  encodeValue,
  type Edits
} from '../src/core/envedit'

const none: Edits = { set: [], add: [], remove: [] }
const setA = (value: string, text = 'A=1\n'): string =>
  applyEdits(text, { ...none, set: [{ key: 'A', value }] })

/** What dotenv and the editor both read back after saving `value` as A. */
function readBack(value: string, text?: string): { dotenv?: string; editor?: string } {
  const saved = setA(value, text)
  return { dotenv: parse(saved)['A'], editor: editorEntries(saved)[0]?.value }
}

const TRICKY = [
  '',
  'plain',
  'with spaces inside',
  '  leading and trailing  ',
  '\ttab',
  'a#b',
  'a # b',
  '#start',
  'key=value=more',
  "it's",
  'say "hi"',
  'back`tick',
  "'single'",
  '"double"',
  '`back`',
  `mixed ' and "`,
  'line1\nline2',
  'line1\n\nline3\n',
  "multi\nline with 'quote'",
  'carriage\rreturn',
  'C:\\path\\to\\dir',
  'C:\\new\\road',
  'ends with \\',
  'literal \\n text',
  'unicode é ✓ 日本',
  '${NOT_EXPANDED}',
  '-----BEGIN KEY-----\nabc+/=\n-----END KEY-----'
]

describe('encodeValue', () => {
  it('writes values dotenv and the editor read back exactly', () => {
    for (const value of TRICKY) {
      let back
      try {
        back = readBack(value)
      } catch (err) {
        expect(err, JSON.stringify(value)).toBeInstanceOf(EditError)
        continue
      }
      expect(back, JSON.stringify(value)).toEqual({ dotenv: value, editor: value })
    }
  })

  it('writes plain values bare and quotes the rest', () => {
    expect(encodeValue('plain')).toBe('plain')
    expect(encodeValue('with spaces inside')).toBe('with spaces inside')
    expect(encodeValue('a#b')).toBe("'a#b'")
    // Quotes only need quoting at the start; inside a bare value they're literal.
    expect(encodeValue("it's")).toBe("it's")
    expect(encodeValue("#it's")).toBe('"#it\'s"')
    expect(encodeValue('carriage\rreturn')).toBe('"carriage\\rreturn"')
    expect(encodeValue('line1\nline2', '\r\n')).toBe("'line1\r\nline2'")
  })

  it('refuses values no quoting can hold', () => {
    expect(() => encodeValue(`# all ' " \` three`)).toThrow(EditError)
    expect(() => encodeValue('# ends with \\')).toThrow(EditError)
    expect(() => encodeValue('cr\r and "quote"')).toThrow(EditError)
  })

  it('never silently changes a value (seeded random sweep)', () => {
    const chars = [
      'a',
      'Z',
      '0',
      ' ',
      '\t',
      '#',
      '=',
      "'",
      '"',
      '`',
      '\\',
      'n',
      'r',
      '\n',
      '\r',
      'é',
      '$'
    ]
    let seed = 0x5eed
    const random = (): number => {
      // mulberry32
      seed = (seed + 0x6d2b79f5) | 0
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
    let written = 0
    for (let n = 0; n < 5000; n++) {
      const length = Math.floor(random() * 9)
      const value = Array.from({ length }, () => chars[Math.floor(random() * chars.length)]).join(
        ''
      )
      for (const text of ['A=1\n', 'A=1\r\n']) {
        let back
        try {
          back = readBack(value, text)
        } catch (err) {
          expect(err, JSON.stringify(value)).toBeInstanceOf(EditError)
          continue
        }
        written++
        expect(back, JSON.stringify(value)).toEqual({ dotenv: value, editor: value })
      }
    }
    // Most values are writable; refusals are the rare all-quotes cases.
    expect(written).toBeGreaterThan(9000)
  })
})

describe('editorEntries', () => {
  it('lists keys in file order with the values dotenv reads', () => {
    const text = [
      '# a comment',
      'PLAIN=value',
      'SPACED =  padded value  ',
      'INLINE=val # comment',
      'HASH=a#b',
      'export EXPORTED=yes',
      'DQ="line1\\nline2" # c',
      "SQ='single \\n raw'",
      'BT=`back`',
      'MULTI="first',
      'second"',
      'EMPTY=',
      'QUOTED_HASH="a # not a comment"',
      '# envvault:local',
      'DB_PATH=',
      ''
    ].join('\n')
    const entries = editorEntries(text)
    const dotenv = parse(text)
    expect(entries.map((e) => e.key)).toEqual(Object.keys(dotenv))
    for (const e of entries) expect(e.value, e.key).toBe(dotenv[e.key])
    expect(entries.filter((e) => e.marked).map((e) => e.key)).toEqual(['DB_PATH'])
  })

  it('refuses a key assigned twice', () => {
    expect(() => editorEntries('A=1\nB=2\nA=3\n')).toThrow(DuplicateKeyError)
  })
})

describe('applyEdits', () => {
  it('leaves untouched lines byte for byte, keeping the prefix and comment of a changed one', () => {
    const file = '\uFEFF# top\r\nexport A=1\r\n  B = two # note\r\n# envvault:local\r\nDB=\r\nC=3'
    expect(applyEdits(file, { ...none, set: [{ key: 'B', value: 'new value' }] })).toBe(
      '\uFEFF# top\r\nexport A=1\r\n  B = new value # note\r\n# envvault:local\r\nDB=\r\nC=3'
    )
    expect(applyEdits(file, { ...none, set: [{ key: 'A', value: '' }] })).toBe(
      '\uFEFF# top\r\nexport A=\r\n  B = two # note\r\n# envvault:local\r\nDB=\r\nC=3'
    )
  })

  it('replaces a multi-line value', () => {
    expect(
      applyEdits('A=1\nPEM="-----BEGIN\nabc\n-----END" # k\nB=2\n', {
        ...none,
        set: [{ key: 'PEM', value: 'x' }]
      })
    ).toBe('A=1\nPEM=x # k\nB=2\n')
    expect(setA('l1\nl2', 'A=1\r\nB=2\r\n')).toBe("A='l1\r\nl2'\r\nB=2\r\n")
  })

  it('removes a key with its marker line', () => {
    expect(applyEdits('A=1\n# envvault:local\nDB=\nB=2\n', { ...none, remove: ['DB'] })).toBe(
      'A=1\nB=2\n'
    )
    expect(applyEdits('A=1\nB=2', { ...none, remove: ['B'] })).toBe('A=1\n')
  })

  it("appends added keys with the file's line ending", () => {
    const add = [
      { key: 'C', value: '3' },
      { key: 'D', value: '' }
    ]
    expect(applyEdits('A=1\r\nB=2', { ...none, add })).toBe('A=1\r\nB=2\r\nC=3\r\nD=\r\n')
    expect(applyEdits('', { ...none, add })).toBe('C=3\nD=\n')
    expect(applyEdits('\uFEFF', { ...none, add })).toBe('\uFEFFC=3\nD=\n')
  })

  it("refuses edits that don't fit the text", () => {
    const text = 'A=1\n# envvault:local\nDB=\n'
    for (const edits of [
      { ...none, set: [{ key: 'DB', value: '/path' }] },
      { ...none, set: [{ key: 'MISSING', value: 'x' }] },
      { ...none, remove: ['MISSING'] },
      { ...none, add: [{ key: 'A', value: '2' }] },
      { ...none, add: [{ key: '1BAD', value: '2' }] },
      { ...none, set: [{ key: 'A', value: '2' }], remove: ['A'] },
      { ...none, set: [{ key: 'A', value: `' " \`` }] }
    ]) {
      expect(() => applyEdits(text, edits), JSON.stringify(edits)).toThrow(EditError)
    }
    expect(() => applyEdits('A=1\nA=2\n', none)).toThrow(DuplicateKeyError)
  })

  it('returns the text unchanged for no edits', () => {
    const text = '# c\r\nA=1\r\n'
    expect(applyEdits(text, none)).toBe(text)
  })
})
