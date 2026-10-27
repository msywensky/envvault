import { describe, expect, it } from 'vitest'
import {
  MAX_SETTINGS_REPOS,
  SettingsError,
  allRepoRules,
  effectiveRules,
  emptySettings,
  parseSettings,
  repoRules,
  sameRepoRules,
  settingsTooLarge,
  withDefaults,
  withRepo,
  type VaultSettings
} from '../src/core/vaultsettings'
import { BUILT_IN_RULES, MAX_PICKED_FILES } from '../src/shared/envrules'

const doc = (over: Partial<VaultSettings> = {}): VaultSettings => ({ ...emptySettings(), ...over })

describe('parseSettings', () => {
  it('accepts what emptySettings and the patches produce', () => {
    const next = withRepo(
      withDefaults(doc(), { include: ['.env', '.env.local'], exclude: [] }),
      'web',
      {
        ignored: true,
        include: null,
        exclude: ['apps/legacy'],
        files: []
      }
    )
    expect(parseSettings(JSON.parse(JSON.stringify(next)))).toEqual(next)
  })

  it.each([
    ['no format', { defaults: { include: [], exclude: [] }, repos: {} }],
    ['a bad pattern', doc({ defaults: { include: ['/abs'], exclude: [] } })],
    ['a bad repo pattern', doc({ repos: { web: { include: ['nope'] } } })],
    ['an upper-case repo id', doc({ repos: { Web: { ignored: true } } })],
    ['an invalid repo id', doc({ repos: { '../x': { ignored: true } } })],
    ['too many patterns', doc({ defaults: { include: Array(21).fill('.env'), exclude: [] } })],
    ['a wrong type', doc({ repos: { web: { ignored: 'yes' as unknown as boolean } } })],
    ['not an object', [1, 2]]
  ])('refuses %s as malformed', (_what, json) => {
    expect(() => parseSettings(json)).toThrow(SettingsError)
    try {
      parseSettings(json)
    } catch (err) {
      expect((err as SettingsError).newer).toBe(false)
    }
  })

  it('drops a __proto__ key without touching the prototype', () => {
    const parsed = parseSettings(
      JSON.parse(
        '{"format":1,"defaults":{"include":[],"exclude":[]},"repos":{"__proto__":{"ignored":true}}}'
      )
    )
    expect(Object.keys(parsed.repos)).toEqual([])
    expect(Object.getPrototypeOf(parsed.repos)).toBe(Object.prototype)
  })

  it('refuses too many repos', () => {
    const repos = Object.fromEntries(
      Array.from({ length: MAX_SETTINGS_REPOS + 1 }, (_, i) => [`r${i}`, { ignored: true }])
    )
    expect(() => parseSettings(doc({ repos }))).toThrow(SettingsError)
  })

  it('tells a newer format apart', () => {
    try {
      parseSettings({ ...doc(), format: 2 })
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(SettingsError)
      expect((err as SettingsError).newer).toBe(true)
    }
  })

  it('keeps fields it does not know, through a patch', () => {
    const json = {
      ...doc(),
      later: { x: 1 },
      defaults: { include: ['.env'], exclude: [], later: true },
      repos: { web: { ignored: true, later: 'y' }, api: { include: ['.env.local'] } }
    }
    const parsed = parseSettings(json)
    const patched = withRepo(parsed, 'web', {
      ignored: false,
      include: null,
      exclude: null,
      files: []
    })
    expect(patched).toMatchObject({
      later: { x: 1 },
      defaults: { later: true },
      repos: { web: { later: 'y' }, api: { include: ['.env.local'] } }
    })
    expect(patched.repos.web).not.toHaveProperty('ignored')
    expect(withDefaults(parsed, BUILT_IN_RULES).defaults).toMatchObject({ later: true })
  })
})

describe('rules', () => {
  it('inherits the defaults list by list', () => {
    const d = withRepo(
      withDefaults(doc(), { include: ['.env', '.env.local'], exclude: ['**/fixtures'] }),
      'web',
      { ignored: false, include: ['.env.local'], exclude: null, files: [] }
    )
    expect(effectiveRules(d, 'web')).toEqual({
      include: ['.env.local'],
      exclude: ['**/fixtures'],
      files: []
    })
    expect(effectiveRules(d, 'api')).toEqual({
      include: ['.env', '.env.local'],
      exclude: ['**/fixtures'],
      files: []
    })
    expect(repoRules(d, 'api')).toEqual({ ignored: false, include: null, exclude: null, files: [] })
  })

  it('never reads a repo id from the prototype', () => {
    expect(repoRules(doc(), 'constructor')).toEqual({
      ignored: false,
      include: null,
      exclude: null,
      files: []
    })
    const d = withRepo(doc(), 'constructor', {
      ignored: true,
      include: null,
      exclude: null,
      files: []
    })
    expect(repoRules(d, 'constructor').ignored).toBe(true)
    expect(parseSettings(JSON.parse(JSON.stringify(d)))).toEqual(d)
  })

  it('drops a repo that is back to all defaults', () => {
    const d = withRepo(doc(), 'web', { ignored: true, include: [], exclude: null, files: [] })
    expect(allRepoRules(d)).toEqual({
      web: { ignored: true, include: [], exclude: null, files: [] }
    })
    const back = withRepo(d, 'web', { ignored: false, include: null, exclude: null, files: [] })
    expect(back.repos).toEqual({})
  })

  it('compares settings', () => {
    const a = { ignored: false, include: ['.env'], exclude: null, files: [] }
    expect(sameRepoRules(a, { ...a, include: ['.env'] })).toBe(true)
    expect(sameRepoRules(a, { ...a, include: null })).toBe(false)
    expect(sameRepoRules(a, { ...a, ignored: true })).toBe(false)
  })

  it('knows when the settings are too large to save', () => {
    expect(settingsTooLarge(doc())).toBe(false)
    const repos = Object.fromEntries(
      Array.from({ length: MAX_SETTINGS_REPOS }, (_, i) => [
        `repo-with-a-long-name-${i}`,
        { include: Array(20).fill('apps/*/.env.production.local') }
      ])
    )
    expect(settingsTooLarge(doc({ repos }))).toBe(true)
  })
})

describe('files picked by hand', () => {
  const picked = (files: unknown): VaultSettings =>
    parseSettings(JSON.parse(JSON.stringify(doc({ repos: { web: { files } as never } }))))

  it('round-trips through a write and a read', () => {
    const d = withRepo(doc(), 'web', {
      ignored: false,
      include: null,
      exclude: null,
      files: ['config/secrets.env']
    })
    expect(parseSettings(JSON.parse(JSON.stringify(d)))).toEqual(d)
    expect(repoRules(d, 'web').files).toEqual(['config/secrets.env'])
    expect(effectiveRules(d, 'web').files).toEqual(['config/secrets.env'])
    const back = withRepo(d, 'web', { ignored: false, include: null, exclude: null, files: [] })
    expect(back.repos).toEqual({})
  })

  it('drops paths this version can’t sync, and copies, instead of failing to read', () => {
    const d = picked(['config/secrets.env', '../x.env', '.gitignore', 'CONFIG/Secrets.env'])
    expect(repoRules(d, 'web').files).toEqual(['config/secrets.env'])
  })

  it('keeps at most MAX_PICKED_FILES', () => {
    const d = picked(Array.from({ length: MAX_PICKED_FILES + 5 }, (_, i) => `f${i}.env`))
    expect(repoRules(d, 'web').files).toHaveLength(MAX_PICKED_FILES)
  })

  it('tells a change of files apart', () => {
    const a = { ignored: false, include: null, exclude: null, files: ['a.env'] }
    expect(sameRepoRules(a, { ...a, files: ['b.env'] })).toBe(false)
    expect(sameRepoRules(a, { ...a, files: ['a.env'] })).toBe(true)
  })
})
