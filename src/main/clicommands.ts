// What the envvault command can do (cliserver.ts is the transport). Like the
// IPC handlers, these take the key through session.withKey and run writes
// inside exclusive(). Unlike them, they never reset the idle timer, so a
// script polling `status` can't keep the vault unlocked. A push is one-sided
// only: it never confirms an overwrite, so a vault copy that changed
// elsewhere is left for the app.
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { ROOT_ENV } from '../core/envpath'
import type { RepoTarget } from '../shared/cli'
import type { EnvFile, RepoRow } from '../shared/types'
import type { CliTable } from './cliserver'
import { AppError } from './errors'
import { exclusive } from './mutex'
import { EnvPath, Expected, RepoName } from './schemas'
import * as session from './session'
import * as sync from './sync'

const Dir = z.string().min(1).max(4096).refine(isAbsolute)
const ByDir = z.strictObject({ dir: Dir, path: EnvPath.optional() })
const ByName = z.strictObject({ repo: RepoName, path: EnvPath.optional() })

/** The env file a request is about, from its repo and path or from a folder inside the repo. */
async function fileOf(key: Uint8Array, target: RepoTarget): Promise<EnvFile> {
  if ('repo' in target) return { repoName: target.repo, path: target.path ?? ROOT_ENV }
  return sync.envTargetAt(key, target.dir, target.path)
}

/** `onPushed` hears about every push that changed the vault copy. */
export function cliCommands(onPushed: (row: RepoRow) => void): CliTable {
  return {
    status: {
      schema: z.union([ByDir, ByName, z.strictObject({ all: z.literal(true) })]),
      run: (args) =>
        session.withKey(async (key, id) => {
          const name =
            'all' in args ? null : 'repo' in args ? args.repo : await sync.repoNameAt(args.dir)
          // Asked for by the user, so git is asked too.
          const list = await sync.listRepos(key, id, {
            find: true,
            ...(name ? { only: name } : {})
          })
          const ignored = list.repos.filter((r) => r.ignored).map((r) => r.name)
          if (name === null) return { rows: list.rows, ignored }
          // `only` is the folder of that name, or else the repo only in the vault.
          if (list.repos.length === 0) {
            throw new AppError('REPO_NOT_FOUND', 'That repo is not in the projects folder.')
          }
          if (ignored.length > 0) {
            throw new AppError('REPO_IGNORED', `${name} is ignored in EnvVault.`)
          }
          return { rows: list.rows, ignored: [] }
        })
    },
    previewPush: {
      schema: z.union([ByDir, ByName]),
      run: (args) =>
        session.withKey(async (key, id) => {
          const file = await fileOf(key, args)
          return {
            repo: file.repoName,
            path: file.path,
            preview: await sync.previewPush(key, id, file)
          }
        })
    },
    push: {
      schema: z.union([
        ByDir.extend({ expected: Expected }),
        ByName.extend({ expected: Expected })
      ]),
      run: async (args) => {
        const row = await exclusive(() =>
          session.withKey(async (key, id) => {
            const file = await fileOf(key, args)
            try {
              return await sync.push(key, id, {
                ...file,
                expected: args.expected,
                overwriteConfirmed: false
              })
            } catch (err) {
              if (err instanceof AppError && err.code === 'OVERWRITE_NOT_CONFIRMED') {
                throw new AppError(
                  err.code,
                  'The vault copy changed on another machine. Resolve it in EnvVault.'
                )
              }
              throw err
            }
          })
        )
        if (row.vault?.contentHash !== args.expected.vaultHash) onPushed(row)
        return row
      }
    }
  }
}
