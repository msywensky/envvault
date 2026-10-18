// Installs the Claude Code skill (core/skill.ts) as a personal skill in
// ~/.claude/skills/envvault, pointing at this app's copy of the envvault
// command. The skill holds no secrets.
import { mkdir, readFile, rm, rmdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { SKILL_MARKER, skillMarkdown } from '../core/skill'
import type { SkillInfo } from '../shared/types'
import { AppError } from './errors'
import { atomicWrite, isErrno } from './fsutil'
import { devProfile } from './profile'

const FILE = 'SKILL.md'

export interface SkillTarget {
  /** The skill's folder. */
  dir: string
  /** The shell command that runs the CLI. */
  command: string
}

/**
 * The CLI runs under plain Node, which can't read inside app.asar, so the
 * packaged copy is unpacked next to it (electron-builder.yml asarUnpack).
 */
export function unpackedPath(file: string): string {
  return file.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2')
}

/** Where this app installs the skill, and the command it uses. */
export function skillTarget(): SkillTarget {
  const cli = unpackedPath(join(__dirname, '../cli/envvault.mjs'))
  const profile = devProfile()
  // Forward slashes work for Node on Windows, and in Git Bash, which Claude Code uses there.
  const command = `node "${cli.replaceAll('\\', '/')}"${profile ? ` --profile ${profile}` : ''}`
  return { dir: join(homedir(), '.claude', 'skills', 'envvault'), command }
}

async function readSkill(target: SkillTarget): Promise<string | null> {
  try {
    return await readFile(join(target.dir, FILE), 'utf8')
  } catch (err) {
    if (isErrno(err, 'ENOENT', 'ENOTDIR')) return null
    throw err
  }
}

function info(target: SkillTarget, text: string | null): SkillInfo {
  const state =
    text === null ? 'missing' : text === skillMarkdown(target.command) ? 'current' : 'different'
  return { state, path: join(target.dir, FILE) }
}

export async function skillStatus(target = skillTarget()): Promise<SkillInfo> {
  return info(target, await readSkill(target))
}

/** Write the skill. A SKILL.md that differs is replaced only with `replace`. */
export async function installSkill(replace: boolean, target = skillTarget()): Promise<SkillInfo> {
  const text = await readSkill(target)
  if (info(target, text).state === 'different' && !replace) {
    throw new AppError('SKILL_EXISTS', 'A different envvault skill is already installed.')
  }
  await mkdir(target.dir, { recursive: true })
  await atomicWrite(target.dir, FILE, skillMarkdown(target.command), { mode: 0o644 })
  return info(target, await readSkill(target))
}

/** Remove the skill, if it is EnvVault's. */
export async function removeSkill(target = skillTarget()): Promise<SkillInfo> {
  const text = await readSkill(target)
  if (text === null) return info(target, null)
  if (!text.includes(SKILL_MARKER)) {
    throw new AppError('SKILL_EXISTS', "That envvault skill wasn't installed by EnvVault.")
  }
  await rm(join(target.dir, FILE), { force: true })
  // Only if nothing else is in the folder.
  await rmdir(target.dir).catch(() => undefined)
  return info(target, null)
}
