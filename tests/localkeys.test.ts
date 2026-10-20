import { describe, expect, it } from 'vitest'
import {
  DuplicateLocalKeyError,
  keepLocal,
  LOCAL_MARKER,
  markedKeys,
  mergePull,
  projectEnv,
  unmarkedKeys
} from '../src/core/localkeys'

const M = LOCAL_MARKER
const text = (...lines: string[]): string => lines.map((l) => l + '\n').join('')

describe('markedKeys', () => {
  it('finds keys directly below a marker, in any spacing', () => {
    expect(
      markedKeys(
        text('A=1', M, 'B=2', '  #envvault:local  ', 'export C = 3', '# envvault:local', 'D=4')
      )
    ).toEqual(['B', 'C', 'D'])
  })

  it('ignores a marker that is not directly above an assignment', () => {
    expect(markedKeys(text(M, '', 'A=1', M, '# other', 'B=2', 'C=3', M))).toEqual([])
    expect(markedKeys(text('# envvault:localhost', 'A=1', '# not envvault:local', 'B=2'))).toEqual(
      []
    )
  })

  it('ignores a marker inside a multi-line value', () => {
    expect(markedKeys(text('PEM="-----BEGIN', M, '-----END"', 'A=1'))).toEqual([])
    expect(markedKeys(text('PEM="-----BEGIN', M, 'B=2', '-----END"'))).toEqual([])
  })
})

describe('projectEnv', () => {
  it('returns null when nothing is marked', () => {
    expect(projectEnv(text('A=1', '# envvault:other', 'B=2'))).toBeNull()
    expect(projectEnv('')).toBeNull()
  })

  it('blanks marked values to a canonical KEY= and keeps everything else', () => {
    expect(
      projectEnv(
        text(
          '# shared',
          'A=1',
          '   #  envvault:local',
          '  export DB_PATH = "/Users/me/data" # mine',
          'B=2 # kept comment'
        )
      )
    ).toBe(text('# shared', 'A=1', M, 'DB_PATH=', 'B=2 # kept comment'))
  })

  it('collapses a marked multi-line value to one line', () => {
    expect(projectEnv(text('A=1', M, 'PEM="-----BEGIN', 'abc', '-----END"', 'B=2'))).toBe(
      text('A=1', M, 'PEM=', 'B=2')
    )
  })

  it('keeps CRLF endings, a BOM and a missing final newline', () => {
    expect(projectEnv(`\uFEFF${M}\r\nDB=x\r\nA=1\r\nB=2`)).toBe(`\uFEFF${M}\r\nDB=\r\nA=1\r\nB=2`)
    expect(projectEnv(`A=1\n${M}\nDB=x`)).toBe(`A=1\n${M}\nDB=`)
  })

  it('projects differently formatted values on two machines the same', () => {
    expect(projectEnv(text('A=1', M, 'export DB = x # here'))).toBe(
      projectEnv(text('A=1', '#envvault:local', "DB='y'"))
    )
  })

  it('refuses a marked key that is assigned more than once', () => {
    expect(() => projectEnv(text('DB=a', M, 'DB=b'))).toThrow(DuplicateLocalKeyError)
    expect(() => projectEnv(text(M, 'DB=a', 'DB=b'))).toThrow(DuplicateLocalKeyError)
  })
})

describe('unmarkedKeys', () => {
  it('lists keys the vault marks that the local file has without a marker', () => {
    const vault = text(M, 'DB=', M, 'PORT=', 'A=1')
    expect(unmarkedKeys(text('DB=x', 'A=1'), vault)).toEqual(['DB'])
    expect(unmarkedKeys(text(M, 'DB=x', 'A=1'), vault)).toEqual([])
    expect(unmarkedKeys(text('DB=x'), null)).toEqual([])
  })
})

describe('mergePull', () => {
  it('returns the vault copy unchanged when nothing is kept', () => {
    expect(mergePull(text('A=2'), text('A=1', 'DB=x'))).toEqual({ text: null, kept: [], unset: [] })
    expect(mergePull(text('A=2'), null)).toEqual({ text: null, kept: [], unset: [] })
  })

  it('keeps the local value of a key the vault marks, and the vault marker', () => {
    const vault = text('A=2', M, 'DB=', 'B=3')
    const merge = mergePull(vault, text('A=1', '  export DB = "/b/data"', 'OLD=x'))
    expect(merge).toEqual({
      text: text('A=2', M, '  export DB = "/b/data"', 'B=3'),
      kept: ['DB'],
      unset: []
    })
    // No ping-pong: the result projects back to the vault copy.
    expect(projectEnv(merge.text ?? '')).toBe(vault)
  })

  it('inserts a local marker the vault copy lacks', () => {
    expect(mergePull(text('A=2', 'DB=/a'), text(M, 'DB=/b', 'A=1')).text).toBe(
      text('A=2', M, 'DB=/b')
    )
  })

  it('appends a kept key the vault copy does not have', () => {
    expect(mergePull(text('A=2'), text('A=1', M, 'DB=/b')).text).toBe(text('A=2', M, 'DB=/b'))
    expect(mergePull('A=2', text(M, 'DB=/b')).text).toBe(text('A=2', M, 'DB=/b'))
    expect(mergePull('A=2\r\n', `${M}\nDB=/b`).text).toBe(`A=2\r\n${M}\r\nDB=/b\r\n`)
    expect(mergePull('', text(M, 'DB=/b')).text).toBe(text(M, 'DB=/b'))
  })

  it('lists vault-marked keys the local file lacks as unset and writes them empty', () => {
    const vault = text(M, 'DB=', M, 'PORT=', 'A=1')
    expect(mergePull(vault, null)).toEqual({ text: null, kept: [], unset: ['DB', 'PORT'] })
    expect(mergePull(vault, text(M, 'DB=/b'))).toEqual({
      text: text(M, 'DB=/b', M, 'PORT=', 'A=1'),
      kept: ['DB'],
      unset: ['PORT']
    })
  })

  it('keeps a multi-line local value verbatim, ending like the vault line', () => {
    expect(
      mergePull(`${M}\r\nPEM=\r\nA=1\r\n`, text(M, 'PEM="-----BEGIN', 'abc', '-----END"')).text
    ).toBe(`${M}\r\nPEM="-----BEGIN\nabc\n-----END"\r\nA=1\r\n`)
  })

  it('keeps the vault copy BOM and drops the local one', () => {
    expect(mergePull(`\uFEFF${M}\nDB=\n`, `\uFEFFDB=/b\n`).text).toBe(`\uFEFF${M}\nDB=/b\n`)
    expect(mergePull(`${M}\nDB=\n`, `\uFEFFDB=/b\n`).text).toBe(`${M}\nDB=/b\n`)
  })

  it('refuses a kept key that is assigned more than once in either file', () => {
    expect(() => mergePull(text(M, 'DB='), text('DB=a', 'DB=b'))).toThrow(DuplicateLocalKeyError)
    expect(() => mergePull(text('DB=', 'DB=x'), text(M, 'DB=a'))).toThrow(DuplicateLocalKeyError)
    // Duplicates of keys that aren't kept are fine.
    expect(mergePull(text('A=1', 'A=2'), text('A=3', 'A=4')).text).toBeNull()
  })
})

describe('mergePull with keys taken from the local file', () => {
  const local = (...keys: string[]): Map<string, 'local'> => new Map(keys.map((k) => [k, 'local']))

  it('puts the local lines of a key both have in the vault position', () => {
    const vault = text('# shared', 'A=2', 'B=vault', 'C=3')
    expect(mergePull(vault, text('C=0', 'B="local" # mine', 'A=1'), local('B'))).toEqual({
      text: text('# shared', 'A=2', 'B="local" # mine', 'C=3'),
      kept: [],
      unset: []
    })
  })

  it('drops a vault key the local file lacks, with its marker line', () => {
    expect(mergePull(text('A=1', 'GONE=x', 'B=2'), text('A=1', 'B=2'), local('GONE')).text).toBe(
      text('A=1', 'B=2')
    )
    expect(mergePull(text('A=1', M, 'GONE=', 'B=2'), text('A=1', 'B=2'), local('GONE')).text).toBe(
      text('A=1', 'B=2')
    )
  })

  it('appends local-only keys in local order, after kept ones in the same order', () => {
    expect(
      mergePull(text('A=1'), text('NEW2=b', M, 'DB=/b', 'A=1', 'NEW1=a'), local('NEW1', 'NEW2'))
        .text
    ).toBe(text('A=1', 'NEW2=b', M, 'DB=/b', 'NEW1=a'))
    expect(mergePull('A=1', text('A=1', 'NEW=a'), local('NEW')).text).toBe(text('A=1', 'NEW=a'))
    expect(mergePull('A=1\r\n', 'NEW=a', local('NEW')).text).toBe('A=1\r\nNEW=a\r\n')
  })

  it('leaves vault lines alone for keys not taken, and kept keys kept', () => {
    const vault = text('A=2', M, 'DB=', 'B=3')
    expect(mergePull(vault, text('A=1', 'DB=/b', 'B=0'), local('A', 'DB')).text).toBe(
      text('A=1', M, 'DB=/b', 'B=3')
    )
  })

  it('keeps a multi-line local value verbatim, ending like the vault line', () => {
    expect(
      mergePull('PEM=x\r\nA=1\r\n', text('PEM="-----BEGIN', 'abc', '-----END"'), local('PEM')).text
    ).toBe('PEM="-----BEGIN\nabc\n-----END"\r\nA=1\r\n')
  })

  it('refuses a taken key that is assigned more than once in either file', () => {
    expect(() => mergePull(text('A=1'), text('A=2', 'A=3'), local('A'))).toThrow(
      DuplicateLocalKeyError
    )
    expect(() => mergePull(text('A=1', 'A=2'), text('A=3'), local('A'))).toThrow(
      DuplicateLocalKeyError
    )
  })

  it('keeps and marks machine-specific keys, in place or appended', () => {
    const vault = text('A=2', 'PORT=3001', 'B=3')
    const merge = mergePull(
      vault,
      text('PORT=3000', 'A=1', 'DEV=x'),
      new Map([
        ['PORT', 'machine'],
        ['DEV', 'machine']
      ])
    )
    expect(merge).toEqual({
      text: text('A=2', M, 'PORT=3000', 'B=3', M, 'DEV=x'),
      kept: ['DEV', 'PORT'],
      unset: []
    })
    // The vault copy then holds the keys without values.
    expect(projectEnv(merge.text ?? '')).toBe(text('A=2', M, 'PORT=', 'B=3', M, 'DEV='))
  })

  it('takes nothing without a local file', () => {
    expect(mergePull(text('A=1'), null, local('A'))).toEqual({ text: null, kept: [], unset: [] })
  })
})

describe('keepLocal', () => {
  it('returns the local file byte for byte when nothing needs a marker', () => {
    const local = '\uFEFF# mine\r\nB=2\r\nexport A = "1" # note\r\nNEW=x'
    expect(keepLocal(text('A=0', '# theirs', 'B=1', 'GONE=y'), local)).toBe(local)
  })

  it('marks keys made machine-specific and keys the vault marks, in place', () => {
    expect(keepLocal(text('A=1', M, 'DB='), text('# db', 'DB=/b', 'PORT=4000'), ['PORT'])).toBe(
      text('# db', M, 'DB=/b', M, 'PORT=4000')
    )
    // Already marked locally: left alone.
    expect(keepLocal(text(M, 'DB='), text(M, 'DB=/b'), ['DB'])).toBe(text(M, 'DB=/b'))
  })

  it("appends the vault's machine-specific keys the local file lacks, empty", () => {
    expect(keepLocal(text(M, 'HOME_DIR=', 'A=1'), 'A=2')).toBe(text('A=2', M, 'HOME_DIR='))
    expect(keepLocal(`${M}\r\nHOME_DIR=\r\n`, 'A=2\r\n')).toBe(`A=2\r\n${M}\r\nHOME_DIR=\r\n`)
  })

  it('refuses a key to mark that is assigned more than once', () => {
    expect(() => keepLocal(text('A=1'), text('PORT=1', 'PORT=2'), ['PORT'])).toThrow(
      DuplicateLocalKeyError
    )
  })
})
