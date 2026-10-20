import { describe, expect, it } from 'vitest'
import {
  BUILT_IN_RULES,
  MAX_PATTERNS,
  isIncluded,
  isReservedEnvName,
  matchesPattern,
  patternProblem,
  rulesProblem
} from '../src/shared/envrules'

describe('patternProblem', () => {
  it.each([
    '.env',
    '.env.local',
    '.env.*',
    '.env*',
    '.env.*.local',
    '.ENV.Local',
    'apps/legacy',
    'apps/*/.env.local',
    '**/fixtures',
    '**/fixtures/**',
    'apps/**',
    '**/.env.test',
    'packages/@acme/db',
    'a+b/.env',
    'x'.repeat(50) + '/.env'
  ])('accepts %s', (p) => expect(patternProblem(p)).toBeNull())

  it.each([
    '',
    '*',
    '**',
    'local',
    '.en',
    '/.env',
    'apps/',
    'apps//.env',
    './.env',
    'apps/../.env',
    'apps/./.env',
    'apps/***/.env',
    'apps/a**/.env',
    'apps\\web',
    'apps web',
    'apps/café',
    'C:/.env',
    `.env.${'x'.repeat(100)}`
  ])('refuses %j', (p) => expect(patternProblem(p)).not.toBeNull())

  it('never repeats the pattern in its message', () => {
    for (const p of ['/secret-name', 'secret name', 'secret', `${'s'.repeat(101)}`]) {
      expect(patternProblem(p)).not.toContain('secret')
    }
  })

  it('limits a list', () => {
    expect(rulesProblem(Array.from({ length: MAX_PATTERNS }, () => '.env'))).toBeNull()
    expect(rulesProblem(Array.from({ length: MAX_PATTERNS + 1 }, () => '.env'))).not.toBeNull()
    expect(rulesProblem(['.env', 'nope'])).not.toBeNull()
  })
})

describe('matchesPattern', () => {
  const cases: [string, string, boolean][] = [
    // A file name matches in every folder.
    ['.env', '.env', true],
    ['.env', 'apps/web/.env', true],
    ['.env', '.env.local', false],
    ['.env.local', 'apps/web/.env.local', true],
    ['.env.*', '.env.local', true],
    ['.env.*', '.env.production.local', true],
    ['.env.*', '.env', false],
    ['.env*', '.env', true],
    ['.env*', 'a/.env.local', true],
    ['.env.*.local', '.env.production.local', true],
    ['.env.*.local', '.env.local', false],
    // Case is ignored, as for paths.
    ['.ENV.LOCAL', 'Apps/.env.local', true],
    ['apps/legacy', 'APPS/Legacy/.env', true],
    // A path is matched from the repo root.
    ['apps/*/.env.local', 'apps/web/.env.local', true],
    ['apps/*/.env.local', 'apps/web/sub/.env.local', false],
    ['apps/*/.env.local', 'x/apps/web/.env.local', false],
    ['**/.env.test', '.env.test', true],
    ['**/.env.test', 'a/b/.env.test', true],
    // Folders cover everything in them.
    ['apps/legacy', 'apps/legacy/.env', true],
    ['apps/legacy', 'apps/legacy/sub/.env.local', true],
    ['apps/legacy', 'apps/legacy-2/.env', false],
    ['apps/legacy', 'apps/.env', false],
    ['apps/**', 'apps/a/b/.env', true],
    ['apps/**', '.env', false],
    ['**/fixtures', 'fixtures/.env', true],
    ['**/fixtures', 'test/fixtures/a/.env', true],
    ['**/fixtures', 'test/fixtures2/.env', false],
    ['apps/*', 'apps/web/.env', true],
    // Characters that mean something in a regular expression mean nothing here.
    ['a+b/**', 'a+b/.env', true],
    ['a+b/**', 'aab/.env', false],
    ['.env.a.b', '.env.aXb', false]
  ]
  it.each(cases)('%s on %s: %s', (pattern, path, expected) =>
    expect(matchesPattern(path, pattern)).toBe(expected)
  )
})

describe('isIncluded', () => {
  it('syncs every .env by default, and nothing else', () => {
    expect(isIncluded('.env', BUILT_IN_RULES)).toBe(true)
    expect(isIncluded('apps/web/.env', BUILT_IN_RULES)).toBe(true)
    expect(isIncluded('.env.local', BUILT_IN_RULES)).toBe(false)
  })

  it('lets exclude win', () => {
    const rules = { include: ['.env', '.env.*'], exclude: ['.env.test', 'apps/legacy'] }
    expect(isIncluded('.env.local', rules)).toBe(true)
    expect(isIncluded('.env.test', rules)).toBe(false)
    expect(isIncluded('apps/legacy/.env', rules)).toBe(false)
    expect(isIncluded('apps/web/.env', rules)).toBe(true)
  })

  it('excludes the root .env while keeping .env.local (the Next.js layout)', () => {
    const rules = { include: ['.env.local'], exclude: [] }
    expect(isIncluded('.env', rules)).toBe(false)
    expect(isIncluded('.env.local', rules)).toBe(true)
  })

  it('includes nothing with no include patterns', () => {
    expect(isIncluded('.env', { include: [], exclude: [] })).toBe(false)
  })
})

describe('isReservedEnvName', () => {
  it('covers backups and templates, in any case', () => {
    for (const name of [
      '.env.bak',
      '.env.bak.20261016T000000Z',
      '.env.bak.tmp-00',
      '.env.example',
      '.env.Example',
      '.env.local.sample'
    ]) {
      expect(isReservedEnvName(name)).toBe(true)
    }
    for (const name of ['.env', '.env.local', '.env.backup', '.env.examples']) {
      expect(isReservedEnvName(name)).toBe(false)
    }
  })
})
