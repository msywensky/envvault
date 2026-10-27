// The vault's settings (settings.enc, encrypted like an entry): the env file
// rules every repo uses unless it has its own, and each repo's own settings,
// by repo id. Every machine reads them; main writes them as patches (see
// sync.ts). Objects keep fields this version doesn't know, so that a newer
// EnvVault can add some without an older one dropping them when it writes;
// `format` changes only for a change an older version must not misread.
import { z } from 'zod'
import {
  BUILT_IN_RULES,
  MAX_PATTERNS,
  MAX_PICKED_FILES,
  patternProblem,
  type FileRules
} from '../shared/envrules'
import type { RepoRules } from '../shared/types'
import { envPathId, isEnvPath } from './envpath'
import { isValidRepoName } from './paths'

export const SETTINGS_FORMAT = 1
export const MAX_SETTINGS_REPOS = 2000
/** The most a serialised settings document may hold. */
export const MAX_SETTINGS_BYTES = 256 * 1024

/** settings.enc doesn't parse; `newer` if a newer EnvVault wrote it. */
export class SettingsError extends Error {
  constructor(
    readonly newer: boolean,
    message: string
  ) {
    super(message)
    this.name = 'SettingsError'
  }
}

const Patterns = z.array(z.string().refine((p) => patternProblem(p) === null)).max(MAX_PATTERNS)

const RepoEntrySchema = z.looseObject({
  ignored: z.boolean().optional(),
  include: Patterns.nullable().optional(),
  exclude: Patterns.nullable().optional(),
  // Checked when read (repoRules), not here: a path a newer EnvVault allows
  // must not make the whole document unreadable to this one.
  files: z.array(z.string()).optional()
})

const RepoId = z.string().refine((id) => isValidRepoName(id) && id === id.toLowerCase())

const SettingsSchema = z.looseObject({
  format: z.literal(SETTINGS_FORMAT),
  updatedBy: z.string().min(1).max(200).optional(),
  updatedAt: z.iso.datetime().optional(),
  defaults: z.looseObject({ include: Patterns, exclude: Patterns }),
  repos: z
    .record(RepoId, RepoEntrySchema)
    .refine((repos) => Object.keys(repos).length <= MAX_SETTINGS_REPOS)
})

export type VaultSettings = z.infer<typeof SettingsSchema>

/** The settings of a vault that has none yet: every .env syncs, nothing is ignored. */
export function emptySettings(): VaultSettings {
  return {
    format: SETTINGS_FORMAT,
    defaults: { include: [...BUILT_IN_RULES.include], exclude: [...BUILT_IN_RULES.exclude] },
    repos: {}
  }
}

/** Validate decrypted settings (see decryptSettings in core/crypto). */
export function parseSettings(json: unknown): VaultSettings {
  const format = z.looseObject({ format: z.int().min(1) }).safeParse(json)
  if (format.success && format.data.format > SETTINGS_FORMAT) {
    throw new SettingsError(true, 'The repo settings were saved by a newer EnvVault.')
  }
  const parsed = SettingsSchema.safeParse(json)
  if (!parsed.success) throw new SettingsError(false, 'The repo settings are malformed.')
  return parsed.data
}

/** True if the settings would be too large to save. */
export const settingsTooLarge = (doc: VaultSettings): boolean =>
  Buffer.byteLength(JSON.stringify(doc)) > MAX_SETTINGS_BYTES

// Own properties only: a repo named "constructor" must not read Object.prototype.
const entryOf = (doc: VaultSettings, repoId: string): z.infer<typeof RepoEntrySchema> | null =>
  Object.hasOwn(doc.repos, repoId) ? (doc.repos[repoId] ?? null) : null

/** A repo's own settings (lists null where it uses the defaults). */
export function repoRules(doc: VaultSettings, repoId: string): RepoRules {
  const entry = entryOf(doc, repoId)
  return {
    ignored: entry?.ignored ?? false,
    include: entry?.include ?? null,
    exclude: entry?.exclude ?? null,
    files: pickedFiles(entry?.files ?? [])
  }
}

/** The paths of `files` this version can sync, once each, at most MAX_PICKED_FILES. */
function pickedFiles(files: readonly string[]): string[] {
  const seen = new Set<string>()
  return files
    .filter((f) => {
      if (!isEnvPath(f) || seen.has(envPathId(f))) return false
      seen.add(envPathId(f))
      return true
    })
    .slice(0, MAX_PICKED_FILES)
}

/** The rules a repo's env files are chosen by: its own lists, or else the defaults. */
export function effectiveRules(doc: VaultSettings, repoId: string): FileRules {
  const own = repoRules(doc, repoId)
  return {
    include: own.include ?? doc.defaults.include,
    exclude: own.exclude ?? doc.defaults.exclude,
    files: own.files
  }
}

// The fields of a repo's entry this version knows (see withRepo).
const REPO_FIELDS = new Set(['ignored', 'include', 'exclude', 'files'])

/** Every repo the settings say something about, by repo id. */
export function allRepoRules(doc: VaultSettings): Record<string, RepoRules> {
  return Object.fromEntries(Object.keys(doc.repos).map((id) => [id, repoRules(doc, id)]))
}

/**
 * The settings with `repoId`'s own replaced by `rules`. A repo back to all
 * defaults loses its entry, unless a newer EnvVault added fields to it.
 */
export function withRepo(doc: VaultSettings, repoId: string, rules: RepoRules): VaultSettings {
  const unknown = Object.fromEntries(
    Object.entries(entryOf(doc, repoId) ?? {}).filter(([field]) => !REPO_FIELDS.has(field))
  )
  const next = {
    ...unknown,
    ...(rules.ignored ? { ignored: true } : {}),
    ...(rules.include ? { include: [...rules.include] } : {}),
    ...(rules.exclude ? { exclude: [...rules.exclude] } : {}),
    ...(rules.files.length ? { files: [...rules.files] } : {})
  }
  const repos = Object.fromEntries(Object.entries(doc.repos).filter(([id]) => id !== repoId))
  if (Object.keys(next).length > 0) repos[repoId] = next
  return { ...doc, repos }
}

/** The settings with new defaults. */
export function withDefaults(doc: VaultSettings, rules: FileRules): VaultSettings {
  return {
    ...doc,
    defaults: { ...doc.defaults, include: [...rules.include], exclude: [...rules.exclude] }
  }
}

const sameList = (a: readonly string[] | null, b: readonly string[] | null): boolean =>
  a === null || b === null ? a === b : a.length === b.length && a.every((p, i) => p === b[i])

/** True if two repos' settings are the same. */
export const sameRepoRules = (a: RepoRules, b: RepoRules): boolean =>
  a.ignored === b.ignored &&
  sameList(a.include, b.include) &&
  sameList(a.exclude, b.exclude) &&
  sameList(a.files, b.files)

/** True if two sets of rules are the same. */
export const sameFileRules = (a: FileRules, b: FileRules): boolean =>
  sameList(a.include, b.include) && sameList(a.exclude, b.exclude)
