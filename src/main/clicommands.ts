// What the envvault command can do (cliserver.ts is the transport). Like the
// IPC handlers, these take the key through session.withKey and run writes
// inside exclusive(). Unlike them, they never reset the idle timer, so a
// script polling `status` can't keep the vault unlocked. A push is one-sided
// only: it never confirms an overwrite, so a vault copy that changed
// elsewhere is left for the app.
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import type { RepoTarget } from '../shared/cli'
import type { RepoRow } from '../shared/types'
import type { CliTable } from './cliserver'
import { getConfig } from './config'
import { AppError } from './errors'
import { exclusive } from './mutex'
import { repoNameAt } from './repos'
import { Expected, RepoName } from './schemas'
import * as session from './session'
import * as sync from './sync'
import { entryId } from './vault'

const Dir = z.string().min(1).max(4096).refine(isAbsolute)
const ByDir = z.strictObject({ dir: Dir })
const ByName = z.strictObject({ repo: RepoName })

/** The repo a request is about, from its name or from a folder inside it. */
async function repoOf(target: RepoTarget): Promise<string> {
  if ('repo' in target) return target.repo
  const { projectsPath } = await getConfig()
  if (!projectsPath) throw new AppError('NOT_CONFIGURED', 'Choose a projects folder first.')
  return repoNameAt(projectsPath, target.dir)
}

/** `onPushed` hears about every push that changed the vault copy. */
export function cliCommands(onPushed: (row: RepoRow) => void): CliTable {
  return {
    status: {
      schema: z.union([ByDir, ByName, z.strictObject({ all: z.literal(true) })]),
      run: (args) =>
        session.withKey(async (key, id) => {
          const name = 'all' in args ? null : await repoOf(args)
          const rows = await sync.listRepos(key, id)
          if (name === null) return rows
          const row = rows.find((r) => entryId(r.name) === entryId(name))
          if (!row) throw new AppError('REPO_NOT_FOUND', 'That repo is not in the projects folder.')
          return [row]
        })
    },
    previewPush: {
      schema: z.union([ByDir, ByName]),
      run: (args) =>
        session.withKey(async (key, id) => {
          const repo = await repoOf(args)
          return { repo, preview: await sync.previewPush(key, id, repo) }
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
            const repoName = await repoOf(args)
            try {
              return await sync.push(key, id, {
                repoName,
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
