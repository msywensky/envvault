import { describe, expect, it } from 'vitest'
import { MASK } from '../src/core/envdiff'
import { MAX_DIFF_CELLS, lineDiff } from '../src/core/linediff'
import type { RawDiffLine } from '../src/shared/types'

/** Compact form: '+3 X=1' (new line 3), '-2 X=0' (old line 2), ' 1/1 A=1', '~5'. */
function show(lines: RawDiffLine[]): string[] {
  return lines.map((l) => {
    if (l.kind === 'gap') return `~${l.count}`
    if (l.kind === 'add') return `+${l.newNo} ${l.text}`
    if (l.kind === 'del') return `-${l.oldNo} ${l.text}`
    return ` ${l.oldNo}/${l.newNo} ${l.text}`
  })
}

const numbered = (from: number, to: number): string[] =>
  Array.from({ length: to - from + 1 }, (_, i) => `K${from + i}=${from + i}`)

describe('lineDiff', () => {
  it('returns nothing when no line changes', () => {
    expect(lineDiff('', '')).toEqual([])
    expect(lineDiff('A=1\nB=2\n', 'A=1\nB=2\n')).toEqual([])
    expect(lineDiff('A=1\nB=2\n', 'A=1\r\nB=2\r\n')).toEqual([])
    expect(lineDiff('A=1\nB=2\n', 'A=1\nB=2')).toEqual([])
  })

  it('shows a changed value as a deletion then an addition', () => {
    expect(show(lineDiff('A=1\nB=old\nC=3\n', 'A=1\nB=new\nC=3\n'))).toEqual([
      ' 1/1 A=1',
      '-2 B=old',
      '+2 B=new',
      ' 3/3 C=3'
    ])
  })

  it('handles additions and removals at the start, middle and end', () => {
    expect(show(lineDiff('B=2\nC=3\n', 'A=1\nB=2\nC=3\n'))).toEqual([
      '+1 A=1',
      ' 1/2 B=2',
      ' 2/3 C=3'
    ])
    expect(show(lineDiff('A=1\nB=2\nC=3\n', 'A=1\nC=3\n'))).toEqual([
      ' 1/1 A=1',
      '-2 B=2',
      ' 3/2 C=3'
    ])
    expect(show(lineDiff('A=1\n', 'A=1\nZ=26\n'))).toEqual([' 1/1 A=1', '+2 Z=26'])
    expect(show(lineDiff('', 'A=1\n'))).toEqual(['+1 A=1'])
    expect(show(lineDiff('A=1\n', ''))).toEqual(['-1 A=1'])
  })

  it('keeps three lines of context and counts the rest as gaps', () => {
    const before = numbered(1, 20)
    const after = [...before]
    after[9] = 'K10=changed'
    const out = lineDiff(before.join('\n'), after.join('\n'))
    expect(show(out)).toEqual([
      '~6',
      ' 7/7 K7=7',
      ' 8/8 K8=8',
      ' 9/9 K9=9',
      '-10 K10=10',
      '+10 K10=changed',
      ' 11/11 K11=11',
      ' 12/12 K12=12',
      ' 13/13 K13=13',
      '~7'
    ])
    // Every original line is accounted for exactly once.
    const oldLines = out.reduce(
      (n, l) => n + (l.kind === 'gap' ? l.count : l.kind === 'add' ? 0 : 1),
      0
    )
    expect(oldLines).toBe(20)
  })

  it('joins nearby changes into one block and honours a custom context', () => {
    const before = numbered(1, 12)
    const after = [...before]
    after[2] = 'K3=x'
    after[7] = 'K8=x'
    const diff = (context: number): string[] =>
      show(lineDiff(before.join('\n'), after.join('\n'), { context }))
    expect(diff(2)).toEqual([
      ' 1/1 K1=1',
      ' 2/2 K2=2',
      '-3 K3=3',
      '+3 K3=x',
      ' 4/4 K4=4',
      ' 5/5 K5=5',
      ' 6/6 K6=6',
      ' 7/7 K7=7',
      '-8 K8=8',
      '+8 K8=x',
      ' 9/9 K9=9',
      ' 10/10 K10=10',
      '~2'
    ])
    expect(diff(1)).toEqual([
      '~1',
      ' 2/2 K2=2',
      '-3 K3=3',
      '+3 K3=x',
      ' 4/4 K4=4',
      '~2',
      ' 7/7 K7=7',
      '-8 K8=8',
      '+8 K8=x',
      ' 9/9 K9=9',
      '~3'
    ])
    expect(diff(0)).toEqual(['~2', '-3 K3=3', '+3 K3=x', '~4', '-8 K8=8', '+8 K8=x', '~4'])
  })

  it('diffs multi-line values line by line', () => {
    const pem = (body: string): string =>
      `KEY="-----BEGIN KEY-----\n${body}\n-----END KEY-----"\nNEXT=1\n`
    expect(show(lineDiff(pem('abc'), pem('xyz')))).toEqual([
      ' 1/1 KEY="-----BEGIN KEY-----',
      '-2 abc',
      '+2 xyz',
      ' 3/3 -----END KEY-----"',
      ' 4/4 NEXT=1'
    ])
  })

  it('makes invisible and reordering characters visible, but not tabs', () => {
    expect(show(lineDiff('A=1\n', '﻿A=1\n'))).toEqual(['-1 A=1', '+1 \\u{FEFF}A=1'])
    expect(show(lineDiff('', 'A=x‮y\tz\u0000\n'))).toEqual(['+1 A=x\\u{202E}y\tz\\u{0000}'])
    // A lone CR (not part of a CRLF) is a real difference.
    expect(show(lineDiff('A=1\n', 'A=1\r'))).toEqual(['-1 A=1', '+1 A=1\\u{000D}'])
  })

  it('falls back to a block replacement for very large changes', () => {
    const side = Math.ceil(Math.sqrt(MAX_DIFF_CELLS)) + 1
    const before = ['SAME=1', ...Array.from({ length: side }, (_, i) => `A${i}=1`), 'END=1']
    const after = ['SAME=1', ...Array.from({ length: side }, (_, i) => `B${i}=1`), 'END=1']
    const out = lineDiff(before.join('\n'), after.join('\n'), { context: 0 })
    expect(out[0]).toEqual({ kind: 'gap', count: 1 })
    expect(out.slice(1, side + 1).every((l) => l.kind === 'del')).toBe(true)
    expect(out.slice(side + 1, 2 * side + 1).every((l) => l.kind === 'add')).toBe(true)
    expect(out[out.length - 1]).toEqual({ kind: 'gap', count: 1 })
    expect(out).toHaveLength(2 * side + 2)
  })

  it('masks values when asked, but still finds value-only changes', () => {
    const before =
      '# Database\nDATABASE_URL=postgres://dev # local\nKEY="-----BEGIN-----\nabc\n-----END-----"\n'
    const after =
      '# Database\nDATABASE_URL=postgres://prod # local\nKEY="-----BEGIN-----\nxyz\n-----END-----"\nNEW=1\n'
    const out = lineDiff(before, after, { mask: true })
    expect(show(out)).toEqual([
      ' 1/1 # Database',
      `-2 DATABASE_URL=${MASK} # local`,
      `+2 DATABASE_URL=${MASK} # local`,
      ` 3/3 KEY=${MASK}`,
      `-4 ${MASK}`,
      `+4 ${MASK}`,
      ` 5/5 ${MASK}`,
      `+6 NEW=${MASK}`
    ])
    const json = JSON.stringify(out)
    for (const secret of ['dev', 'prod', 'abc', 'xyz', 'BEGIN']) {
      expect(json).not.toContain(secret)
    }
    // Same structure as the unmasked diff, so the two can be swapped in place.
    const strip = (lines: typeof out): unknown[] =>
      lines.map((l) => (l.kind === 'gap' ? l : { ...l, text: '' }))
    expect(strip(out)).toEqual(strip(lineDiff(before, after)))
  })

  it('makes invisible characters visible in masked lines too', () => {
    expect(show(lineDiff('A=1\n', '\uFEFFA=1\n', { mask: true }))).toEqual([
      `-1 A=${MASK}`,
      `+1 \\u{FEFF}A=${MASK}`
    ])
  })
})
