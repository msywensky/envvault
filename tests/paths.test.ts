import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { PathEscapeError, isInside, isValidRepoName, resolveInside } from '../src/core/paths'

describe('isValidRepoName', () => {
  it.each(['api', 'my-app', 'my_app', 'App.v2', 'a', '9lives', 'x'.repeat(100)])(
    'accepts %s',
    (name) => expect(isValidRepoName(name)).toBe(true)
  )

  it.each([
    '',
    '.',
    '..',
    '.git',
    '.github',
    '.hidden',
    'trailing.',
    'has space',
    'a/b',
    'a\\b',
    '../x',
    '..\\x',
    'C:',
    'name:stream',
    'x'.repeat(101),
    'CON',
    'nul',
    'com1',
    'LPT9.txt',
    'café'
  ])('rejects %j', (name) => expect(isValidRepoName(name)).toBe(false))
})

describe('resolveInside', () => {
  const root = path.resolve('/projects')

  it('returns the joined absolute path for a child', () => {
    expect(resolveInside(root, 'app', '.env')).toBe(path.join(root, 'app', '.env'))
  })

  it.each([
    ['../x'],
    ['..\\x'],
    ['a/../../b'],
    ['..'],
    [''],
    ['.'],
    [path.resolve('/elsewhere/file').split(path.sep).join('/')]
  ])('rejects %j', (part) => {
    expect(() => resolveInside(root, part)).toThrow(PathEscapeError)
  })

  it('allows names that merely start with two dots', () => {
    expect(resolveInside(root, '..foo')).toBe(path.join(root, '..foo'))
  })

  it.each([['app.'], ['app '], ['a/b.'], ['...'], ['a\\b'], ['x\u0000y']])(
    'rejects backslashes, NUL and segments Windows would alias (%j)',
    (part) => {
      expect(() => resolveInside(root, part)).toThrow(PathEscapeError)
    }
  )

  it('allows . and .. segments that stay inside', () => {
    expect(resolveInside(root, 'a/./b/../c')).toBe(path.join(root, 'a', 'c'))
  })
})

describe('isInside', () => {
  const root = path.resolve('/projects')

  it('is true only strictly inside the root', () => {
    expect(isInside(root, path.join(root, 'app'))).toBe(true)
    expect(isInside(root, root)).toBe(false)
    expect(isInside(root, path.resolve('/projects-other/app'))).toBe(false)
    expect(isInside(root, path.resolve('/'))).toBe(false)
  })

  it.runIf(process.platform === 'win32')('compares case-insensitively on Windows', () => {
    expect(isInside('C:\\Projects', 'c:\\projects\\app')).toBe(true)
    expect(isInside('C:\\Projects', 'D:\\Projects\\app')).toBe(false)
  })
})
