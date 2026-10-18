// One store instance per location, so a store can queue its own writes and
// a git store can reuse what it fetched.
import { app } from 'electron'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import type { VaultLocation } from '../../shared/types'
import { FolderStore } from './folder'
import { GitStore } from './git'
import type { VaultStore } from './types'

const stores = new Map<string, VaultStore>()

export function storeFor(location: VaultLocation): VaultStore {
  const id =
    location.kind === 'folder'
      ? `folder:${resolve(location.path)}`
      : `git:${location.url}\n${location.branch}`
  let store = stores.get(id)
  if (!store) stores.set(id, (store = create(location, id)))
  return store
}

function create(location: VaultLocation, id: string): VaultStore {
  if (location.kind === 'folder') return new FolderStore(location.path)
  // The mirror's folder name is derived from the URL and branch, never made of them.
  const hash = createHash('sha256').update(id).digest('hex').slice(0, 16)
  const dir = join(app.getPath('userData'), 'git-vaults', `${hash}.git`)
  return new GitStore({ url: location.url, branch: location.branch, dir })
}
