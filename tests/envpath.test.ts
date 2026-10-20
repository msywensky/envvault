import { describe, expect, it } from 'vitest'
import {
  ROOT_ENV,
  envFileName,
  envFolders,
  envPathId,
  isEnvFileName,
  isEnvPath
} from '../src/core/envpath'

describe('isEnvFileName', () => {
  it.each([
    '.env',
    '.env.local',
    '.env.production.local',
    '.env.Local',
    '.env.keys',
    '.env.e2e_test',
    '.env.my-app',
    '.env.backup',
    `.env.${'x'.repeat(95)}`
  ])('accepts %s', (name) => expect(isEnvFileName(name)).toBe(true))

  it.each([
    '',
    'env',
    '.ENV',
    '.envrc',
    '.env.',
    '.env..local',
    '.env.local.',
    '.env/local',
    '.env.lo cal',
    'prod.env',
    '.env.example',
    '.env.EXAMPLE',
    '.env.sample',
    '.env.template',
    '.env.dist',
    '.env.defaults',
    '.env.local.example',
    '.env.bak',
    '.env.BAK',
    '.env.bak.20261016T000000Z',
    '.env.bak.local.20261016T000000Z',
    '.env.bak.tmp-0123456789abcdef',
    `.env.${'x'.repeat(96)}`
  ])('rejects %j', (name) => expect(isEnvFileName(name)).toBe(false))
})

describe('isEnvPath', () => {
  it.each([
    '.env',
    '.env.local',
    'apps/web/.env',
    'apps/web/.env.local',
    'apps/web/.env.production.local',
    'packages/db/.env',
    'supabase/functions/.env',
    '.devcontainer/.env',
    'packages/@acme/db/.env',
    'services/api_v2/.env',
    'a+b/.env',
    '..foo/.env',
    'a/b/c/d/e/f/g/h/.env',
    `${'x'.repeat(100)}/.env`
  ])('accepts %s', (path) => expect(isEnvPath(path)).toBe(true))

  it.each([
    '',
    '/',
    '/.env',
    'apps/web/',
    'apps/web',
    '.env/',
    'env',
    '.ENV',
    '.env.example',
    'apps/web/.env.example',
    'apps/web/.env.bak.20261016T000000Z',
    'apps/web/prod.env',
    'apps/web/.env.',
    './.env',
    'apps/./.env',
    '../.env',
    'apps/../.env',
    'apps//.env',
    '.git/.env',
    'apps/.GIT/.env',
    'apps\\web\\.env',
    'apps\\web/.env',
    'apps/web./.env',
    'apps/web /.env',
    'apps/my app/.env',
    'C:/.env',
    'apps/web:stream/.env',
    'con/.env',
    'apps/LPT1.txt/.env',
    'apps/café/.env',
    'apps/web\u0000/.env',
    'a/b/c/d/e/f/g/h/i/.env',
    `${'x'.repeat(101)}/.env`,
    `${Array.from({ length: 3 }, () => 'x'.repeat(90)).join('/')}/.env`
  ])('rejects %j', (path) => expect(isEnvPath(path)).toBe(false))
})

describe('path helpers', () => {
  it('splits a path into its folders and file name', () => {
    expect(envFolders(ROOT_ENV)).toEqual([])
    expect(envFolders('apps/web/.env')).toEqual(['apps', 'web'])
    expect(envFileName(ROOT_ENV)).toBe('.env')
    expect(envFileName('apps/web/.env')).toBe('.env')
    expect(envFolders('apps/web/.env.local')).toEqual(['apps', 'web'])
    expect(envFileName('apps/web/.env.local')).toBe('.env.local')
  })

  it('compares paths case-insensitively, like the filesystems', () => {
    expect(envPathId('Apps/Web/.env')).toBe(envPathId('apps/web/.env'))
  })
})
