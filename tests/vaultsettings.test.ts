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
import { BUILT_IN_RULES } from '../src/shared/envrules'

const doc = (over: Partial<VaultSettings> = {}): VaultSettings => ({ ...emptySettings(), ...over })

describe('parseSettings', () => {
  it('accepts what emptySettings and the patches produce', () => {
    const next = withRepo(
      withDefaults(doc(), { include: ['.env', '.env.local'], exclude: [] }),
      'web',
      {
        ignored: true,
        include: null,
        exclude: ['apps/legacy']
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
    const patched = withRepo(parsed, 'web', { ignored: false, include: null, exclude: null })
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
      { ignored: false, include: ['.env.local'], exclude: null }
    )
    expect(effectiveRules(d, 'web')).toEqual({ include: ['.env.local'], exclude: ['**/fixtures'] })
    expect(effectiveRules(d, 'api')).toEqual({
      include: ['.env', '.env.local'],
      exclude: ['**/fixtures']
    })
    expect(repoRules(d, 'api')).toEqual({ ignored: false, include: null, exclude: null })
  })

  it('never reads a repo id from the prototype', () => {
    expect(repoRules(doc(), 'constructor')).toEqual({
      ignored: false,
      include: null,
      exclude: null
    })
    const d = withRepo(doc(), 'constructor', { ignored: true, include: null, exclude: null })
    expect(repoRules(d, 'constructor').ignored).toBe(true)
    expect(parseSettings(JSON.parse(JSON.stringify(d)))).toEqual(d)
  })

  it('drops a repo that is back to all defaults', () => {
    const d = withRepo(doc(), 'web', { ignored: true, include: [], exclude: null })
    expect(allRepoRules(d)).toEqual({ web: { ignored: true, include: [], exclude: null } })
    const back = withRepo(d, 'web', { ignored: false, include: null, exclude: null })
    expect(back.repos).toEqual({})
  })

  it('compares settings', () => {
    const a = { ignored: false, include: ['.env'], exclude: null }
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
