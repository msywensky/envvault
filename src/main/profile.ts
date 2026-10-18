// Dev-only: ENVVAULT_PROFILE=<name> gives an unpackaged run its own userData
// folder (see index.ts). Names that don't match PROFILE_RE are ignored.
import { app } from 'electron'
import { PROFILE_RE } from '../shared/cli'

export function devProfile(): string | null {
  const name = process.env['ENVVAULT_PROFILE']
  return !app.isPackaged && name && PROFILE_RE.test(name) ? name : null
}
