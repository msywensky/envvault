// One store instance per location, so a store can queue its own writes and
// a git store can reuse what it fetched.
import { app } from 'electron'
import { createHash } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { VaultLocation } from '../../shared/types'
import { FolderStore } from './folder'
import { GitStore } from './git'
import type { VaultStore } from './types'

const stores = new Map<string, VaultStore>()

export function storeFor(location: VaultLocation): VaultStore {
  const id = idOf(location)
  let store = stores.get(id)
  if (!store) stores.set(id, (store = create(location, id)))
  return store
}

/** Forget a git location's store and delete its mirror (a repository that was refused). */
export async function discardStore(location: VaultLocation): Promise<void> {
  if (location.kind !== 'git') return
  const id = idOf(location)
  stores.delete(id)
  await rm(mirrorDir(id), { recursive: true, force: true })
}

const idOf = (location: VaultLocation): string =>
  location.kind === 'folder'
    ? `folder:${resolve(location.path)}`
    : `git:${location.url}\n${location.branch}`

// The mirror's folder name is derived from the URL and branch, never made of them.
const mirrorDir = (id: string): string =>
  join(
    app.getPath('userData'),
    'git-vaults',
    `${createHash('sha256').update(id).digest('hex').slice(0, 16)}.git`
  )

function create(location: VaultLocation, id: string): VaultStore {
  if (location.kind === 'folder') return new FolderStore(location.path)
  return new GitStore({ url: location.url, branch: location.branch, dir: mirrorDir(id) })
}
