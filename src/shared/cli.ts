// The protocol between the envvault command (src/cli) and the app
// (src/main/cliserver.ts). Like every IPC channel except the raw diff and the
// editor, it carries key names, statuses and hashes, never values.
// Relative imports only, like the rest of src/shared.
import type { Expected, PushPreview, RepoRow } from './types'

/** Bumped whenever a request or response changes shape. */
export const CLI_PROTOCOL = 2

/** Dev profile names (ENVVAULT_PROFILE, --profile). scripts/dev-profile.mjs keeps a copy. */
export const PROFILE_RE = /^[A-Za-z0-9-]{1,20}$/

/**
 * Which env file: from the command's working directory, the .env in the
 * nearest folder at or above it within its repo (else the repo's root .env);
 * or a repo by name, with the file's path in it (its root .env if left out).
 * `status` uses only the repo.
 */
export type RepoTarget = { dir: string } | { repo: string; path?: string }

export interface CliArgs {
  status: RepoTarget | { all: true }
  previewPush: RepoTarget
  push: RepoTarget & { expected: Expected }
}

export interface CliResponses {
  /** A row per env file of the repo, or of every repo with `all`. */
  status: RepoRow[]
  previewPush: { repo: string; path: string; preview: PushPreview }
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
