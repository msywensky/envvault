// The protocol between the envvault command (src/cli) and the app
// (src/main/cliserver.ts). Like every IPC channel except the raw diff and the
// editor, it carries key names, statuses and hashes, never values.
// Relative imports only, like the rest of src/shared.
import type { Expected, PushPreview, RepoRow } from './types'

/** Bumped whenever a request or response changes shape. */
export const CLI_PROTOCOL = 1

/** Dev profile names (ENVVAULT_PROFILE, --profile). scripts/dev-profile.mjs keeps a copy. */
export const PROFILE_RE = /^[A-Za-z0-9-]{1,20}$/

/** Which repo: the one containing the command's working directory, or one by name. */
export type RepoTarget = { dir: string } | { repo: string }

export interface CliArgs {
  status: RepoTarget | { all: true }
  previewPush: RepoTarget
  push: RepoTarget & { expected: Expected }
}

export interface CliResponses {
  /** One row, or every row with `all`. */
  status: RepoRow[]
  previewPush: { repo: string; preview: PushPreview }
  push: RepoRow
}

export type CliCommand = keyof CliResponses

/** One request per connection, sent as a single line of JSON. */
export interface CliRequest<C extends CliCommand = CliCommand> {
  v: number
  /** The contents of the token file (see core/cliendpoint). */
  token: string
  command: C
  args: CliArgs[C]
}
