// Is a vault repository private? EnvVault asks the host over https with
// none of your credentials: if it lists the branches, the repository is
// public. Your credentials would make a private repository look public, so
// git runs with nothing of yours: an environment built from scratch (no
// askpass programs, no config passed through variables), an empty home and
// global config, no system config, no credential helper, and a working
// folder outside any repository. That also rules out ~/.netrc,
// ~/.git-credentials and insteadOf rewrites to ssh.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  classifyAnonymous,
  GitRemoteError,
  httpsFormOf,
  parseGitRemote
} from '../../core/gitremote'
import { AppError } from '../errors'
import { requireGitVersion, runGit } from '../git'

const TIMEOUT_MS = 20_000

// Kept from your environment: where git is, proxies (they hold no repository
// credentials), and what Windows needs to start a process and open sockets.
const KEPT = [
  'PATH',
  'SystemRoot',
  'windir',
  'TEMP',
  'TMP',
  'http_proxy',
  'https_proxy',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'all_proxy',
  'ALL_PROXY',
  'no_proxy',
  'NO_PROXY'
]

/** The whole environment for an anonymous git command, with `home` an empty folder. */
export function anonymousEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const name of KEPT) {
    const value = process.env[name]
    if (value !== undefined) env[name] = value
  }
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(home, 'gitconfig'),
    GIT_CEILING_DIRECTORIES: dirname(home),
    GIT_TERMINAL_PROMPT: '0',
    LC_ALL: 'C'
  }
}

/** -c settings for an anonymous git command. */
export const ANONYMOUS_ARGS = [
  '-c',
  'credential.helper=',
  '-c',
  'core.askPass=',
  '-c',
  'protocol.allow=never',
  '-c',
  'protocol.https.allow=always'
]

/** Throws GIT_VAULT_PUBLIC, or GIT_VAULT_UNVERIFIED if the host's answer isn't clear. */
export async function checkPrivate(url: string): Promise<void> {
  // GIT_CONFIG_GLOBAL is what keeps your global config out.
  await requireGitVersion()
  let https: string
  try {
    https = httpsFormOf(parseGitRemote(url))
  } catch (err) {
    if (err instanceof GitRemoteError) throw new AppError('GIT_VAULT_INVALID_URL', err.message)
    throw err
  }
  const home = await mkdtemp(join(tmpdir(), 'envvault-anon-'))
  try {
    await writeFile(join(home, 'gitconfig'), '')
    // The pattern matches no branch, so a public repository with many
    // branches prints nothing; the exit code is what counts.
    const result = await runGit(
      [...ANONYMOUS_ARGS, 'ls-remote', '--heads', https, 'refs/heads/envvault-privacy-check'],
      { cwd: home, env: anonymousEnv(home), timeoutMs: TIMEOUT_MS }
    )
    const visibility = classifyAnonymous(result.code, result.stderr)
    if (visibility === 'public') {
      throw new AppError(
        'GIT_VAULT_PUBLIC',
        'This repository is public. Use a private repository for the vault.'
      )
    }
    if (visibility === 'unknown') {
      throw new AppError(
        'GIT_VAULT_UNVERIFIED',
        "EnvVault couldn't confirm that this repository is private. It asks the host over https without your credentials and got no clear answer. Check your network. If the repository is on your own server, you can confirm that it is private."
      )
    }
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}
