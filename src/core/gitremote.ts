// Git remote URLs for a git vault. The renderer sends one (pasted or picked
// from a list), so it's parsed strictly here before git ever sees it: only
// https://, ssh:// and scp-style user@host:path, never credentials, local
// paths, file:// or other transports, and nothing git or ssh could read as
// an option. Errors are fixed strings that never quote the input.

export interface GitRemote {
  form: 'https' | 'ssh' | 'scp'
  /** The URL as given (it was accepted exactly as is). */
  url: string
  host: string
  /** The repository path, starting with "/" for https and ssh. */
  path: string
}

export class GitRemoteError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GitRemoteError'
  }
}

const MAX_URL_CHARS = 2048
// DNS names only: no IPv6 literals, and never a leading "-", which ssh would
// read as an option (CVE-2017-1000117).
const LABEL = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?'
const HOST = `(${LABEL}(?:\\.${LABEL})*)`
const USER = '([A-Za-z0-9_][A-Za-z0-9._-]*)'
const PORT = '(?::(\\d{1,5}))?'
const PATH_CHARS = '[A-Za-z0-9._~%+/-]'

const HTTPS_RE = new RegExp(`^https://${HOST}${PORT}(/${PATH_CHARS}*)$`)
const SSH_RE = new RegExp(`^ssh://(?:${USER}@)?${HOST}${PORT}(/${PATH_CHARS}*)$`)
const SCP_RE = new RegExp(`^${USER}@${HOST}:(${PATH_CHARS}+)$`)

const INVALID = 'Use an https:// or ssh:// URL, or one like git@github.com:you/vault.git.'

export function parseGitRemote(url: string): GitRemote {
  if (url.length === 0 || url.length > MAX_URL_CHARS) throw new GitRemoteError(INVALID)
  // Whitespace and control characters: git and ssh split or misread them.
  if (/[\s\p{Cc}]/u.test(url) || url.startsWith('-')) throw new GitRemoteError(INVALID)
  if (credentialsIn(url)) {
    throw new GitRemoteError(
      "Leave credentials out of the URL: EnvVault uses your git's own (SSH key or credential helper)."
    )
  }
  if (/^http:\/\//i.test(url)) throw new GitRemoteError('Use https://, not http://.')

  let m = HTTPS_RE.exec(url)
  if (m) return checked({ form: 'https', url, host: m[1] ?? '', path: m[3] ?? '' }, m[2])
  m = SSH_RE.exec(url)
  if (m) return checked({ form: 'ssh', url, host: m[2] ?? '', path: m[4] ?? '' }, m[3])
  m = SCP_RE.exec(url)
  if (m) return checked({ form: 'scp', url, host: m[2] ?? '', path: m[3] ?? '' }, undefined)
  throw new GitRemoteError(INVALID)
}

/** A user:password (or token) in https:// or ssh://, or any user in https://. */
function credentialsIn(url: string): boolean {
  const authority = /^[a-z][a-z0-9+.-]*:\/\/([^/]*)/i.exec(url)?.[1]
  if (!authority?.includes('@')) return false
  return /^https:/i.test(url) || authority.slice(0, authority.lastIndexOf('@')).includes(':')
}

function checked(remote: GitRemote, port: string | undefined): GitRemote {
  if (port !== undefined && (Number(port) < 1 || Number(port) > 65535)) {
    throw new GitRemoteError(INVALID)
  }
  const segments = remote.path.split('/')
  // A path that is only slashes or dots names no repository; ".." is never needed.
  if (segments.includes('..') || !segments.some((s) => s !== '' && s !== '.')) {
    throw new GitRemoteError(INVALID)
  }
  if (remote.path.startsWith('-')) throw new GitRemoteError(INVALID)
  return remote
}

/**
 * A branch name EnvVault will use: what `git check-ref-format --branch`
 * allows, narrowed to plain characters (no leading "-", "..", "//", "@{",
 * ".lock" components, or a leading or trailing "/" or ".").
 */
export function isBranchName(name: string): boolean {
  return (
    /^[A-Za-z0-9._/-]{1,100}$/.test(name) && !/^[-/.]|[/.]$|\.\.|\/\/|\/\.|\.lock(\/|$)/.test(name)
  )
}

/**
 * The https:// address of the same repository, for asking anonymously
 * whether it's public: git@host:o/r.git and ssh://host:22/o/r both become
 * https://host/o/r.git (the user and the SSH port are dropped).
 */
export function httpsFormOf(remote: GitRemote): string {
  if (remote.form === 'https') return remote.url
  const path = remote.path.startsWith('/') ? remote.path : `/${remote.path}`
  return `https://${remote.host}${path.endsWith('.git') ? path : `${path}.git`}`
}

export type Visibility = 'public' | 'private' | 'unknown'

// What git prints when the server asked for credentials it didn't get.
const AUTH_REQUIRED = [
  /could not read Username/i,
  /terminal prompts disabled/i,
  /Authentication failed/i,
  /HTTP Basic: Access denied/i,
  /requested URL returned error: 40[13]\b/i
]

/**
 * What an anonymous `git ls-remote` over https says about a repository.
 * Only a server asking for credentials means private. A 404 or "not found"
 * is unknown: if the https path we derived isn't where this host serves the
 * repository, it says nothing about the repository itself.
 */
export function classifyAnonymous(exitCode: number | null, stderr: string): Visibility {
  if (exitCode === 0) return 'public'
  if (exitCode !== null && AUTH_REQUIRED.some((re) => re.test(stderr))) return 'private'
  return 'unknown'
}

/** [major, minor] from `git --version`, or null. */
export function parseGitVersion(output: string): [number, number] | null {
  const m = /^git version (\d+)\.(\d+)/.exec(output.trim())
  return m ? [Number(m[1]), Number(m[2])] : null
}
