import type { VaultLocation } from '../../shared/types'

/** How a vault location is shown: the folder's path. */
export function vaultLabel(location: VaultLocation | null | undefined): string {
  return location?.path ?? ''
}
