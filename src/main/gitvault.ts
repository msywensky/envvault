// Choosing a git repository as the vault. Everything is checked before it's
// saved, so Settings never holds a repository that couldn't be used.
import { app } from 'electron'
import { GitRemoteError, parseGitRemote } from '../core/gitremote'
import type { VaultLocation } from '../shared/types'
import { getConfig } from './config'
import { AppError } from './errors'
import { requireGitVersion } from './git'
import { discardStore, storeFor } from './store'
import { defaultBranch, GitStore } from './store/git'
import { checkPrivate } from './store/gitprivacy'
import { isVaultFile } from './vault'

type GitLocation = Extract<VaultLocation, { kind: 'git' }>

// What a new repository may come with: GitHub's and GitLab's starter files.
const EXTRAS = /^(?:(?:README|LICENSE|LICENCE)(?:\.[A-Za-z0-9]+)?|\.gitignore|\.gitattributes)$/i

/**
 * The location of a repository that can be the vault: the URL is valid, git
 * is new enough, you can reach it, it's private, and it's empty or already a
 * vault. Talks to the network, so run it outside exclusive().
 */
export async function prepareGitVault(url: string): Promise<GitLocation> {
  try {
    parseGitRemote(url)
  } catch (err) {
    if (err instanceof GitRemoteError) throw new AppError('GIT_VAULT_INVALID_URL', err.message)
    throw err
  }
  await requireGitVersion()
  const branch = await defaultBranch(url, app.getPath('userData'))
  await checkPrivate(url)
  const location: GitLocation = { kind: 'git', url, branch }
  const store = storeFor(location)
  if (!(store instanceof GitStore)) throw new Error('Expected a git store.')
  if (holdsOtherFiles(await store.topLevel())) {
    // Don't keep a mirror of someone's project, unless it's the vault in use.
    const current = (await getConfig()).vault
    if (current?.kind !== 'git' || current.url !== url || current.branch !== branch) {
      await discardStore(location)
    }
    throw new AppError(
      'GIT_VAULT_NOT_EMPTY',
      'This repository already holds other files. Use an empty private repository just for the vault.'
    )
  }
  return location
}

/**
 * True if a repository holds anything besides vault files and starter files,
 * so a project repository isn't turned into a vault by mistake.
 */
export function holdsOtherFiles(entries: { name: string; file: boolean }[]): boolean {
  return entries.some((e) => !e.file || !(isVaultFile(e.name) || EXTRAS.test(e.name)))
}
