import { describe, expect, it } from 'vitest'
import { DuplicateKeyError } from '../src/core/envedit'
import { compareEnv, differingValues, MergeError, takesFor } from '../src/core/envmerge'
import { LOCAL_MARKER, mergePull, projectEnv } from '../src/core/localkeys'

const M = LOCAL_MARKER
const text = (...lines: string[]): string => lines.map((l) => l + '\n').join('')

describe('compareEnv', () => {
  it('lists differing and local-only keys in local order, then vault-only in vault order', () => {
    const cmp = compareEnv(
      text('B=local', 'NEW2=x', 'A=1', 'NEW1=y'),
      text('A=1', 'GONE2=z', 'B=vault', 'GONE1=w')
    )
    expect(cmp).toEqual({
      keys: [
        { key: 'B', kind: 'differs' },
        { key: 'NEW2', kind: 'local-only' },
        { key: 'NEW1', kind: 'local-only' },
        { key: 'GONE2', kind: 'vault-only' },
        { key: 'GONE1', kind: 'vault-only' }
      ],
      kept: [],
      unset: [],
      unchanged: 1
    })
  })

  it('compares values as parseEnv reads them, so quoting and comments alone are no difference', () => {
    const cmp = compareEnv(text('A="x" # local', 'export B=y'), text('A=x', 'B = y # vault'))
    expect(cmp.keys).toEqual([])
    expect(cmp.unchanged).toBe(2)
  })

  it('leaves machine-specific keys out, as kept or unset', () => {
    const cmp = compareEnv(
      text(M, 'DB=/a', 'PORT=3000', 'A=1'),
      text('DB=/vault', M, 'PORT=', M, 'HOME_DIR=', 'A=2')
    )
    expect(cmp).toEqual({
      keys: [{ key: 'A', kind: 'differs' }],
      kept: ['DB', 'PORT'],
      unset: ['HOME_DIR'],
      unchanged: 0
    })
  })

  it('compares multi-line values, CRLF and a BOM', () => {
    const cmp = compareEnv(
      '﻿PEM="-----BEGIN\r\nabc\r\n-----END"\r\nA=1\r\n',
      'PEM="-----BEGIN\nabd\n-----END"\nA=1'
    )
    expect(cmp.keys).toEqual([{ key: 'PEM', kind: 'differs' }])
    expect(cmp.unchanged).toBe(1)
  })

  it('refuses a key assigned more than once in either file', () => {
    expect(() => compareEnv(text('A=1', 'A=2'), text('A=1'))).toThrow(DuplicateKeyError)
    expect(() => compareEnv(text('A=1'), text('B=1', 'B=2'))).toThrow(DuplicateKeyError)
  })
})

describe('differingValues', () => {
  it("returns both copies' values of the listed keys, as dotenv reads them", () => {
    expect(
      differingValues(
        text('A="one\\ntwo"', 'NEW=x # note', 'SAME=1'),
        text('A=1', 'SAME=1', "GONE='y'")
      )
    ).toEqual([
      { key: 'A', local: 'one\ntwo', vault: '1' },
      { key: 'NEW', local: 'x', vault: null },
      { key: 'GONE', local: null, vault: 'y' }
    ])
  })

  it('never returns machine-specific values', () => {
    expect(differingValues(text(M, 'DB=/a', 'A=1'), text(M, 'DB=', 'A=1'))).toEqual([])
  })
})

describe('takesFor', () => {
  const cmp = compareEnv(text('A=1', 'NEW=x'), text('A=2', 'GONE=y'))

  it('returns the keys taken from the local file', () => {
    const takes = takesFor(cmp, [
      { key: 'A', take: 'local' },
      { key: 'NEW', take: 'vault' },
      { key: 'GONE', take: 'local' }
    ])
    expect([...takes.keys()]).toEqual(['A', 'GONE'])
  })

  it('refuses missing, repeated and unknown keys', () => {
    const all = [
      { key: 'A', take: 'local' as const },
      { key: 'NEW', take: 'local' as const },
      { key: 'GONE', take: 'vault' as const }
    ]
    expect(() => takesFor(cmp, all.slice(1))).toThrow(MergeError)
    expect(() => takesFor(cmp, [...all, all[0]!])).toThrow(MergeError)
    expect(() => takesFor(cmp, [...all, { key: 'OTHER', take: 'local' }])).toThrow(MergeError)
  })
})

describe('resolving with mergePull', () => {
  it('builds the file from the chosen copies, in the vault layout, and projects back to itself', () => {
    const local = text('A=local', M, 'DB=/a', 'NEW=x', 'SAME=1')
    const vault = text('# from the vault', 'SAME=1', 'A=vault', M, 'DB=', 'GONE=y')
    const takes = takesFor(compareEnv(local, vault), [
      { key: 'A', take: 'vault' },
      { key: 'NEW', take: 'local' },
      { key: 'GONE', take: 'local' }
    ])
    const merged = mergePull(vault, local, takes).text ?? ''
    expect(merged).toBe(text('# from the vault', 'SAME=1', 'A=vault', M, 'DB=/a', 'NEW=x'))
    expect(compareEnv(merged, projectEnv(merged) ?? merged).keys).toEqual([])
  })
})
