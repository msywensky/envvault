import { describe, expect, it } from 'vitest'
import { MASK, diffKeys, maskEnvLines, parseEnv } from '../src/core/envdiff'

describe('parseEnv', () => {
  it('parses plain, quoted and exported values', () => {
    const env = parseEnv(
      [
        '# a comment',
        '',
        'PLAIN=value',
        'export EXPORTED=yes',
        'DQ="double quoted # not a comment"',
        "SQ='single'",
        'BT=`back`',
        'EMPTY=',
        'SPACED = padded value  ',
        'INLINE=val # trailing comment',
        'URL=postgres://u:p@h/db?x=1=2'
      ].join('\n')
    )
    expect(Object.fromEntries(env)).toEqual({
      PLAIN: 'value',
      EXPORTED: 'yes',
      DQ: 'double quoted # not a comment',
      SQ: 'single',
      BT: 'back',
      EMPTY: '',
      SPACED: 'padded value',
      INLINE: 'val',
      URL: 'postgres://u:p@h/db?x=1=2'
    })
  })

  it('handles CRLF line endings', () => {
    expect(Object.fromEntries(parseEnv('A=1\r\nB=2\r\n'))).toEqual({ A: '1', B: '2' })
  })

  it('reads multi-line quoted values', () => {
    const env = parseEnv('KEY="-----BEGIN-----\nabc\n-----END-----"\nNEXT=1')
    expect(env.get('KEY')).toBe('-----BEGIN-----\nabc\n-----END-----')
    expect(env.get('NEXT')).toBe('1')
  })

  it('ignores junk lines and invalid keys', () => {
    const env = parseEnv('just text\n=novalue\n1BAD=x\nGOOD=1\n  # indented comment')
    expect([...env.keys()]).toEqual(['GOOD'])
  })

  it('treats an unterminated quote as an unquoted value instead of eating the file', () => {
    const env = parseEnv('A="oops\nB=1\nC=2')
    expect(Object.fromEntries(env)).toEqual({ A: '"oops', B: '1', C: '2' })
  })

  it('honours backslash-escaped quotes', () => {
    const a = parseEnv('K="a\\"b"\nNEXT=1')
    const b = parseEnv('K="a\\"c"\nNEXT=1')
    expect(a.get('K')).toBe('a\\"b')
    expect(a.get('NEXT')).toBe('1')
    expect(a.get('K')).not.toBe(b.get('K'))
  })

  it('reads a comment-only value as empty', () => {
    expect(parseEnv('KEY= # note').get('KEY')).toBe('')
    expect(parseEnv('KEY=#note').get('KEY')).toBe('')
  })

  it('strips export followed by any whitespace', () => {
    expect([...parseEnv('export\tTABBED=1\nexport  TWO=2').keys()]).toEqual(['TABBED', 'TWO'])
  })

  it('lets a later duplicate win', () => {
    expect(parseEnv('A=1\nA=2').get('A')).toBe('2')
  })

  it('returns an empty map for an empty file', () => {
    expect(parseEnv('').size).toBe(0)
  })
})

describe('maskEnvLines', () => {
  const M = MASK

  it('keeps keys and blank lines, and masks every value', () => {
    expect(
      maskEnvLines([
        'PLAIN=value',
        'export EXPORTED = yes',
        '  INDENTED=1',
        '',
        '   ',
        'DQ="quoted # not a comment"',
        'NOSPACE=abc#def'
      ])
    ).toEqual([
      `PLAIN=${M}`,
      `export EXPORTED =${M}`,
      `  INDENTED=${M}`,
      '',
      '   ',
      `DQ=${M}`,
      `NOSPACE=${M}`
    ])
  })

  it('shows assignments with an empty value as they are', () => {
    expect(maskEnvLines(['EMPTY=', 'SPACES=   ', 'QUOTED=""', 'NOTE= # fill in'])).toEqual([
      'EMPTY=',
      'SPACES=   ',
      'QUOTED=""',
      'NOTE= # fill in'
    ])
  })

  it('passes comments through, whole-line and after a value', () => {
    expect(
      maskEnvLines([
        '# Database',
        '  # indented',
        '# OLD_KEY=kept-because-comments-are-not-values',
        'INLINE=val # trailing comment',
        'DQ="quoted" # after the quote',
        'JUNK_AFTER="quoted" junk'
      ])
    ).toEqual([
      '# Database',
      '  # indented',
      '# OLD_KEY=kept-because-comments-are-not-values',
      `INLINE=${M} # trailing comment`,
      `DQ=${M} # after the quote`,
      `JUNK_AFTER=${M}`
    ])
  })

  it('masks the continuation lines of a multi-line value whole', () => {
    expect(
      maskEnvLines([
        'KEY="-----BEGIN-----',
        'abc',
        '# not a comment',
        '-----END-----" # note',
        'NEXT=1'
      ])
    ).toEqual([`KEY=${M}`, M, M, `${M} # note`, `NEXT=${M}`])
  })

  it('treats an unterminated quote as one line, like parseEnv', () => {
    expect(maskEnvLines(['A="oops', 'B=1'])).toEqual([`A=${M}`, `B=${M}`])
  })

  it('masks junk lines and invalid keys whole', () => {
    expect(maskEnvLines(['just text', '=novalue', '1BAD=x', 'sk_live_secret'])).toEqual([
      M,
      M,
      M,
      M
    ])
  })

  it('never leaves a value behind', () => {
    const text = [
      'A=hunter2',
      'B="hunter2',
      'hunter2"',
      "export C = 'hunter2' # a comment",
      'D=hunter2 # another',
      'hunter2'
    ]
    expect(maskEnvLines(text).join('\n')).not.toContain('hunter2')
  })
})

describe('diffKeys', () => {
  const local = parseEnv('A=1\nB=secret-b\nC=3\nNEW=secret-new')
  const vault = parseEnv('A=1\nB=other-b\nC=3\nGONE=secret-gone')

  it('reports added, removed and changed names, sorted', () => {
    expect(diffKeys(local, vault)).toEqual({
      added: ['NEW'],
      removed: ['GONE'],
      changed: ['B'],
      unchanged: 2
    })
  })

  it('is directional (pull is the reverse of push)', () => {
    expect(diffKeys(vault, local)).toEqual({
      added: ['GONE'],
      removed: ['NEW'],
      changed: ['B'],
      unchanged: 2
    })
  })

  it('never includes values', () => {
    const json = JSON.stringify(diffKeys(local, vault))
    for (const secret of ['secret-b', 'other-b', 'secret-new', 'secret-gone']) {
      expect(json).not.toContain(secret)
    }
  })

  it('handles empty files', () => {
    expect(diffKeys(new Map(), parseEnv('A=1'))).toEqual({
      added: [],
      removed: ['A'],
      changed: [],
      unchanged: 0
    })
  })
})
