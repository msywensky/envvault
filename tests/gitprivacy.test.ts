// The anonymous https check that a git vault is private
// (src/main/store/gitprivacy.ts): git must run with none of your config or
// credentials, or a private repository would look public.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { ANONYMOUS_ARGS, anonymousEnv } from '../src/main/store/gitprivacy'

const root = mkdtempSync(join(tmpdir(), 'envvault-anon-test-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const INHERITED = {
  GIT_ASKPASS: '/bin/echo',
  SSH_ASKPASS: '/bin/echo',
  GIT_CONFIG_PARAMETERS: "'credential.helper'='store'",
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'url.git@github.com:.insteadOf',
  GIT_CONFIG_VALUE_0: 'https://github.com/',
  GIT_CONFIG_GLOBAL: join(root, 'yours.gitconfig'),
  GIT_DIR: root
}

describe('the anonymous environment', () => {
  it('leaves out every way git could find your credentials or config', () => {
    writeFileSync(INHERITED.GIT_CONFIG_GLOBAL, '[credential]\n\thelper = store\n')
    const saved = Object.fromEntries(Object.keys(INHERITED).map((k) => [k, process.env[k]]))
    Object.assign(process.env, INHERITED)
    try {
      const home = mkdtempSync(join(root, 'home-'))
      writeFileSync(join(home, 'gitconfig'), '')
      const env = anonymousEnv(home)
      for (const name of Object.keys(INHERITED).filter((k) => k !== 'GIT_CONFIG_GLOBAL')) {
        expect(env, name).not.toHaveProperty(name)
      }
      expect(env['GIT_CONFIG_GLOBAL']).toBe(join(home, 'gitconfig'))

      // No system, global or repository config at all (Xcode's git has a
      // credential.helper in a config file of its own, for one).
      const list = (args: string[]): string[] =>
        execFileSync('git', [...args, 'config', '--list', '--show-origin'], { cwd: home, env })
          .toString()
          .split('\n')
          .filter(Boolean)
      expect(list([])).toEqual([])
      // Only our own -c settings, which switch the rest off.
      expect(list(ANONYMOUS_ARGS).every((line) => line.startsWith('command line:'))).toBe(true)
      expect(list(ANONYMOUS_ARGS).join('\n')).toMatch(/credential\.helper=$/m)
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  })
})
