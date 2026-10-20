// Request schemas for every channel. Main-process only (it imports core), so
// zod never reaches the renderer or the sandboxed preload.
import { z } from 'zod'
import { KEY_RE } from '../core/envdiff'
import { isEnvPath } from '../core/envpath'
import { isBranchName } from '../core/gitremote'
import { REPO_NAME_RE } from './gh'
import { isValidRepoName } from '../core/paths'
import { CH } from '../shared/channels'
import { MAX_PATTERNS, MAX_PATTERN_LENGTH, patternProblem } from '../shared/envrules'

const NoArgs = z.undefined()
/** A sha256 hex digest. */
export const Hash = z.string().regex(/^[0-9a-f]{64}$/)
export const RepoName = z.string().max(100).refine(isValidRepoName)
/** An env file's path in its repo (see core/envpath): never absolute, never outside it. */
export const EnvPath = z.string().max(255).refine(isEnvPath)
/** An env file: the fields every per-file request starts with. */
const File = { repoName: RepoName, path: EnvPath }
const Password = z.string().min(1).max(1024)
export const Expected = z.strictObject({ localHash: Hash.nullable(), vaultHash: Hash.nullable() })
const PullReq = z.strictObject({ ...File, expected: Expected })
const EnvKey = z.string().max(200).regex(KEY_RE)
const EnvChange = z.strictObject({ key: EnvKey, value: z.string().max(1024 * 1024) })
const MergeChoice = z.strictObject({ key: EnvKey, take: z.enum(['local', 'vault', 'machine']) })
/** Env file patterns (see shared/envrules): chosen among the files found in a repo, never a path. */
const Patterns = z
  .array(
    z
      .string()
      .max(MAX_PATTERN_LENGTH)
      .refine((p) => patternProblem(p) === null)
  )
  .max(MAX_PATTERNS)

/** Shown in the UI and stored (encrypted) as `updatedBy`. No control characters. */
export const MachineName = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[^\p{Cc}]+$/u)

export const AutoLockMinutes = z.int().min(1).max(120)
export const BackupCount = z.int().min(1).max(50)

/** Where the vault is kept (config.json only: the renderer never sends one). */
// A git URL is only bounded here; GitStore parses it before git sees it.
export const VaultLocation = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('folder'), path: z.string().min(1) }),
  z.strictObject({
    kind: z.literal('git'),
    url: z.string().min(1).max(2048),
    branch: z.string().refine(isBranchName),
    privateConfirmed: z.literal(true).optional()
  })
])

export const LayoutReq = z.discriminatedUnion('layout', [
  z.strictObject({ layout: z.literal('full') }),
  z.strictObject({ layout: z.literal('mini'), ...File, reviewing: z.boolean() })
])

export const requestSchemas = {
  [CH.getState]: NoArgs,
  [CH.activity]: NoArgs,
  [CH.getSettings]: NoArgs,
  [CH.saveSettings]: z.strictObject({
    autoLock: z.boolean(),
    autoLockMinutes: AutoLockMinutes,
    machineName: MachineName,
    checkExample: z.boolean(),
    autoPull: z.boolean(),
    backups: z.boolean(),
    backupCount: BackupCount,
    cliAccess: z.boolean(),
    miniOnTop: z.boolean()
  }),
  [CH.pickFolder]: z.strictObject({ which: z.enum(['projects', 'vault']) }),
  // Only bounded here: prepareGitVault parses it before git sees it.
  [CH.setGitVault]: z.strictObject({
    url: z.string().trim().min(1).max(2048),
    confirmPrivate: z.boolean()
  }),
  [CH.ghStatus]: NoArgs,
  [CH.listGitRepos]: NoArgs,
  [CH.createGitRepo]: z.strictObject({ name: z.string().regex(REPO_NAME_RE) }),
  [CH.openNewRepoPage]: NoArgs,
  [CH.createVault]: z.strictObject({ password: Password, setupCode: z.boolean() }),
  // Bounded only: parseSetupCode reads it.
  [CH.unlock]: z.strictObject({
    password: Password,
    setupCode: z.string().min(1).max(100).optional()
  }),
  [CH.lock]: NoArgs,
  [CH.showSetupCode]: z.strictObject({ password: Password }),
  [CH.listRepos]: z.strictObject({ rescan: z.boolean() }),
  [CH.previewPush]: z.strictObject(File),
  [CH.push]: z.strictObject({
    ...File,
    overwriteConfirmed: z.boolean(),
    expected: Expected
  }),
  [CH.previewPull]: z.strictObject(File),
  [CH.pull]: PullReq,
  [CH.pullRawDiff]: PullReq.extend({ values: z.boolean() }),
  [CH.previewMerge]: z.strictObject(File),
  [CH.mergeValues]: PullReq,
  [CH.merge]: PullReq.extend({ choices: z.array(MergeChoice).max(1000) }),
  [CH.openEditor]: z.strictObject(File),
  [CH.saveEdit]: z.strictObject({
    ...File,
    expectedVaultHash: Hash.nullable(),
    set: z.array(EnvChange).max(1000),
    add: z.array(EnvChange).max(1000),
    remove: z.array(EnvKey).max(1000),
    mark: z.array(EnvKey).max(1000)
  }),
  [CH.removeFromVault]: z.strictObject({
    vaultName: RepoName,
    path: EnvPath,
    expectedVaultHash: Hash
  }),
  [CH.addGitignore]: z.strictObject(File),
  [CH.saveRepoSettings]: z.strictObject({
    vaultName: RepoName,
    ignored: z.boolean(),
    include: Patterns.nullable(),
    exclude: Patterns.nullable()
  }),
  [CH.setVaultName]: z.strictObject({ repoName: RepoName, vaultName: RepoName }),
  [CH.saveDefaults]: z.strictObject({ include: Patterns, exclude: Patterns }),
  [CH.resetSettings]: NoArgs,
  [CH.skillStatus]: NoArgs,
  [CH.installSkill]: z.strictObject({ replace: z.boolean() }),
  [CH.removeSkill]: NoArgs,
  [CH.setLayout]: LayoutReq
} as const
