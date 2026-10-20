import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { SKILL_MARKER, skillMarkdown } from '../src/core/skill'

// src/main/skill.ts checks app.isPackaged for the dev profile.
vi.mock('electron', () => ({ app: { isPackaged: false } }))

const COMMAND = 'node "/Apps/EnvVault/out/cli/envvault.mjs"'

function frontmatter(text: string): string {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text)
  if (!m?.[1]) throw new Error('no frontmatter')
  return m[1]
}

describe('skillMarkdown', () => {
  const text = skillMarkdown(COMMAND)

  it('pre-approves only the read-only commands', () => {
    const fm = frontmatter(text)
    expect(fm).toMatch(/^name: envvault$/m)
    expect(fm).toMatch(/^description: .+/m)
    const allowed = fm.split('\n').filter((l) => l.startsWith('  - '))
    expect(allowed).toEqual([
      `  - Bash(${COMMAND} status *)`,
      `  - Bash(${COMMAND} push --dry-run *)`
    ])
  })

  it('pushes only with the token from a dry run, after asking', () => {
    expect(text).toContain(`${COMMAND} push --dry-run --json`)
    expect(text).toContain(`${COMMAND} push --expect <token> --json`)
    expect(text).toContain('Never push without a yes.')
    expect(text).not.toContain('--yes')
  })

  it('explains which env file a push uses, in a monorepo and with variants too', () => {
    expect(text).toContain('the nearest one above it in the repo')
    expect(text).toContain("run it from the package's folder")
    expect(text).toContain('`--path apps/web/.env`')
    expect(text).toContain('`--path .env.local`')
    expect(text).toContain('`data.repo` and `data.path` say which file it is')
    expect(text).toContain('`ENV_AMBIGUOUS`')
    expect(text).toContain("Don't work around it.")
  })

  it('tells Claude never to touch env files, and is marked as EnvVault’s', () => {
    expect(text).toContain(
      'Never read, print, search, copy or edit `.env`, `.env.*` or `.env.bak.*` files'
    )
    expect(text).toContain(SKILL_MARKER)
  })
})

describe('installing the skill', () => {
  let root: string
  let target: { dir: string; command: string }
  let skill: typeof import('../src/main/skill')

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'envvault-skill-'))
    target = { dir: join(root, '.claude', 'skills', 'envvault'), command: COMMAND }
    skill = await import('../src/main/skill')
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  const file = (): string => join(target.dir, 'SKILL.md')

  it('installs, and knows when it is current', async () => {
    expect(await skill.skillStatus(target)).toEqual({ state: 'missing', path: file() })
    expect((await skill.installSkill(false, target)).state).toBe('current')
    expect(readFileSync(file(), 'utf8')).toBe(skillMarkdown(COMMAND))
    // Installing again is harmless.
    expect((await skill.installSkill(false, target)).state).toBe('current')
  })

  it('replaces a different SKILL.md only when asked', async () => {
    const moved = { ...target, command: 'node "/Elsewhere/envvault.mjs"' }
    expect((await skill.skillStatus(moved)).state).toBe('different')
    await expect(skill.installSkill(false, moved)).rejects.toMatchObject({ code: 'SKILL_EXISTS' })
    expect(readFileSync(file(), 'utf8')).toBe(skillMarkdown(COMMAND))
    expect((await skill.installSkill(true, moved)).state).toBe('current')
    expect((await skill.skillStatus(target)).state).toBe('different')
  })

  it('removes only its own skill, and the folder if nothing else is in it', async () => {
    writeFileSync(file(), '---\nname: envvault\n---\nSomeone else’s skill.\n')
    await expect(skill.removeSkill(target)).rejects.toMatchObject({ code: 'SKILL_EXISTS' })
    expect(existsSync(file())).toBe(true)

    await skill.installSkill(true, target)
    mkdirSync(join(target.dir, 'notes'))
    expect((await skill.removeSkill(target)).state).toBe('missing')
    expect(existsSync(file())).toBe(false)
    expect(existsSync(target.dir)).toBe(true)

    rmSync(join(target.dir, 'notes'), { recursive: true })
    await skill.installSkill(false, target)
    await skill.removeSkill(target)
    expect(existsSync(target.dir)).toBe(false)
    expect((await skill.removeSkill(target)).state).toBe('missing')
  })

  it('points a packaged app at its unpacked CLI', () => {
    expect(
      skill.unpackedPath(
        '/Applications/EnvVault.app/Contents/Resources/app.asar/out/cli/envvault.mjs'
      )
    ).toBe('/Applications/EnvVault.app/Contents/Resources/app.asar.unpacked/out/cli/envvault.mjs')
    expect(
      skill.unpackedPath('C:\\Programs\\envvault\\resources\\app.asar\\out\\cli\\envvault.mjs')
    ).toBe('C:\\Programs\\envvault\\resources\\app.asar.unpacked\\out\\cli\\envvault.mjs')
    const dev = '/Users/me/envvault/out/cli/envvault.mjs'
    expect(skill.unpackedPath(dev)).toBe(dev)
  })

  it('points at this checkout’s CLI, with the dev profile if there is one', () => {
    const saved = process.env['ENVVAULT_PROFILE']
    try {
      delete process.env['ENVVAULT_PROFILE']
      const plain = skill.skillTarget()
      expect(plain.command).toMatch(/^node ".*\/cli\/envvault\.mjs"$/)
      expect(plain.command).not.toContain('\\')
      expect(plain.dir).toMatch(/[\\/]\.claude[\\/]skills[\\/]envvault$/)

      process.env['ENVVAULT_PROFILE'] = 'kvtest'
      expect(skill.skillTarget().command).toBe(`${plain.command} --profile kvtest`)
      process.env['ENVVAULT_PROFILE'] = 'not valid!'
      expect(skill.skillTarget().command).toBe(plain.command)
    } finally {
      if (saved === undefined) delete process.env['ENVVAULT_PROFILE']
      else process.env['ENVVAULT_PROFILE'] = saved
    }
  })
})
