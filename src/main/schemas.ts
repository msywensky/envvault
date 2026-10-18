// Request schemas for every channel. Main-process only (it imports core), so
// zod never reaches the renderer or the sandboxed preload.
import { z } from 'zod'
import { KEY_RE } from '../core/envdiff'
import { isValidRepoName } from '../core/paths'
import { CH } from '../shared/channels'

const NoArgs = z.undefined()
/** A sha256 hex digest. */
export const Hash = z.string().regex(/^[0-9a-f]{64}$/)
const RepoName = z.string().max(100).refine(isValidRepoName)
const Password = z.string().min(1).max(1024)
const Expected = z.strictObject({ localHash: Hash.nullable(), vaultHash: Hash.nullable() })
const PullReq = z.strictObject({ repoName: RepoName, expected: Expected })
const EnvKey = z.string().max(200).regex(KEY_RE)
const EnvChange = z.strictObject({ key: EnvKey, value: z.string().max(1024 * 1024) })

/** Shown in the UI and stored (encrypted) as `updatedBy`. No control characters. */
export const MachineName = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[^\p{Cc}]+$/u)

export const AutoLockMinutes = z.int().min(1).max(120)

export const requestSchemas = {
  [CH.getState]: NoArgs,
  [CH.activity]: NoArgs,
  [CH.getSettings]: NoArgs,
  [CH.saveSettings]: z.strictObject({
    autoLockMinutes: AutoLockMinutes,
    machineName: MachineName,
    checkExample: z.boolean()
  }),
  [CH.pickFolder]: z.strictObject({ which: z.enum(['projects', 'vault']) }),
  [CH.createVault]: z.strictObject({ password: Password }),
  [CH.unlock]: z.strictObject({ password: Password }),
  [CH.lock]: NoArgs,
  [CH.listRepos]: NoArgs,
  [CH.previewPush]: z.strictObject({ repoName: RepoName }),
  [CH.push]: z.strictObject({
    repoName: RepoName,
    overwriteConfirmed: z.boolean(),
    expected: Expected
  }),
  [CH.previewPull]: z.strictObject({ repoName: RepoName }),
  [CH.pull]: PullReq,
  [CH.pullRawDiff]: PullReq.extend({ values: z.boolean() }),
  [CH.openEditor]: z.strictObject({ repoName: RepoName }),
  [CH.saveEdit]: z.strictObject({
    repoName: RepoName,
    expectedVaultHash: Hash.nullable(),
    set: z.array(EnvChange).max(1000),
    add: z.array(EnvChange).max(1000),
    remove: z.array(EnvKey).max(1000)
  }),
  [CH.addGitignore]: z.strictObject({ repoName: RepoName })
} as const
