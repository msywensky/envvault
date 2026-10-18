// One store instance per location, so a store can queue its own writes.
import { resolve } from 'node:path'
import { FolderStore } from './folder'
import type { VaultStore } from './types'

const stores = new Map<string, VaultStore>()

export function storeFor(location: { kind: 'folder'; path: string }): VaultStore {
  const id = `folder:${resolve(location.path)}`
  let store = stores.get(id)
  if (!store) stores.set(id, (store = new FolderStore(location.path)))
  return store
}
