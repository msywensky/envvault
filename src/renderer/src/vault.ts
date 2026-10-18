import type { VaultLocation } from '../../shared/types'

/** How a vault location is shown: the folder's path, or the repository's URL. */
export function vaultLabel(location: VaultLocation | null | undefined): string {
  if (!location) return ''
  return location.kind === 'folder' ? location.path : location.url
}
