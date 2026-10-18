// The GitHub CLI, for creating and listing vault repositories. Git can't
// create a repository on a host, so this is optional: pasting any git URL
// always works. EnvVault passes gh fixed arguments and a validated
// repository name only; gh keeps the token, and its JSON output is parsed
// strictly and never logged.
import { tmpdir } from 'node:os'
import { z } from 'zod'
import { GitRemoteError, parseGitRemote } from '../core/gitremote'
import type { GhStatus, GitRepoChoice } from '../shared/types'
import { AppError } from './errors'
import { findExecutable, firstLine, runProcess, type RunResult } from './exec'
import { isErrno } from './fsutil'

/** Runs gh with these arguments, or resolves to null if gh isn't installed. */
export type GhRunner = (args: string[]) => Promise<RunResult | null>

export const DEFAULT_REPO_NAME = 'envvault-vault'
/** A name for a new repository. Never starts with "-" (an option) or ".". */
export const REPO_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/
const DESCRIPTION = 'EnvVault vault (encrypted .env files)'
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/
const NAME_WITH_OWNER_RE = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/

/** GitHub's new-repository page, filled in. The only URL EnvVault opens. */
export const NEW_REPO_PAGE =
  'https://github.com/new?name=envvault-vault&visibility=private&description=EnvVault+vault+%28encrypted+.env+files%29'

const unavailable = (): AppError =>
  new AppError(
    'GH_UNAVAILABLE',
    'The GitHub CLI is not available or not signed in. Run `gh auth login`, or paste the repository URL.'
  )

async function runGh(args: string[]): Promise<RunResult | null> {
  // Looked up each time: you may install gh while EnvVault is open.
  const exe = await findExecutable('gh')
  if (!exe) return null
  const env = {
    ...process.env,
    GH_PROMPT_DISABLED: '1',
    GH_NO_UPDATE_NOTIFIER: '1',
    GH_SPINNER_DISABLED: '1',
    NO_COLOR: '1'
  }
  try {
    return await runProcess(exe, args, { cwd: tmpdir(), env, timeoutMs: 30_000, maxBytes: 4 << 20 })
  } catch (err) {
    if (isErrno(err, 'ENOENT')) return null
    throw err
  }
}

const text = (r: RunResult | null): string | null =>
  r?.code === 0 ? r.stdout.toString('utf8').trim() : null

async function protocolOf(run: GhRunner): Promise<GhStatus['protocol']> {
  const value = text(await run(['config', 'get', 'git_protocol', '--host', 'github.com']))
  return value === 'ssh' ? 'ssh' : 'https'
}

async function loginOf(run: GhRunner): Promise<string | null> {
  const login = text(await run(['api', 'user', '--jq', '.login']))
  return login && LOGIN_RE.test(login) ? login : null
}

export async function ghStatus(run: GhRunner = runGh): Promise<GhStatus> {
  const auth = await run(['auth', 'status', '--hostname', 'github.com'])
  if (!auth) return { available: false, signedIn: false, login: null, protocol: 'https' }
  if (auth.code !== 0) return { available: true, signedIn: false, login: null, protocol: 'https' }
  const [login, protocol] = await Promise.all([loginOf(run), protocolOf(run)])
  return { available: true, signedIn: login !== null, login, protocol }
}

const RepoList = z.array(
  z.object({
    nameWithOwner: z.string().regex(NAME_WITH_OWNER_RE),
    sshUrl: z.string(),
    url: z.string(),
    isEmpty: z.boolean(),
    updatedAt: z.string().max(40)
  })
)

/** The clone URL gh would use itself, if EnvVault accepts it. */
function cloneUrl(
  repo: { sshUrl: string; url: string },
  protocol: GhStatus['protocol']
): string | null {
  const url = protocol === 'ssh' ? repo.sshUrl : `${repo.url}.git`
  try {
    parseGitRemote(url)
    return url
  } catch (err) {
    if (err instanceof GitRemoteError) return null
    throw err
  }
}

/** Your private, non-archived, non-fork repositories: empty ones first, then the latest. */
export async function listPrivateRepos(run: GhRunner = runGh): Promise<GitRepoChoice[]> {
  const [listed, protocol] = await Promise.all([
    run([
      'repo',
      'list',
      '--visibility',
      'private',
      '--no-archived',
      '--source',
      '--limit',
      '100',
      '--json',
      'nameWithOwner,sshUrl,url,isEmpty,updatedAt'
    ]),
    protocolOf(run)
  ])
  const out = text(listed)
  if (out === null) throw unavailable()
  let repos: z.infer<typeof RepoList>
  try {
    repos = RepoList.parse(JSON.parse(out))
  } catch {
    throw new AppError('GH_UNAVAILABLE', "The GitHub CLI's list of repositories wasn't understood.")
  }
  const choices: GitRepoChoice[] = []
  for (const repo of repos) {
    const url = cloneUrl(repo, protocol)
    if (url) {
      choices.push({
        name: repo.nameWithOwner,
        url,
        isEmpty: repo.isEmpty,
        updatedAt: repo.updatedAt
      })
    }
  }
  return choices.sort(
    (a, b) => Number(b.isEmpty) - Number(a.isEmpty) || b.updatedAt.localeCompare(a.updatedAt)
  )
}

/** Create a private repository for the vault under your account; returns its clone URL. */
export async function createPrivateRepo(name: string, run: GhRunner = runGh): Promise<string> {
  if (!REPO_NAME_RE.test(name)) {
    throw new AppError('BAD_REQUEST', 'Use letters, digits, ".", "-" and "_" for the name.')
  }
  const login = await loginOf(run)
  if (!login) throw unavailable()
  const created = await run([
    'repo',
    'create',
    name,
    '--private',
    '--disable-issues',
    '--disable-wiki',
    '--description',
    DESCRIPTION
  ])
  if (!created) throw unavailable()
  if (created.code !== 0) {
    if (/name already exists/i.test(created.stderr)) {
      throw new AppError(
        'GIT_VAULT_NAME_TAKEN',
        'You already have a repository with that name. Pick another, or select it as an existing one.'
      )
    }
    const first = created.failure ? created.failure : firstLine(created.stderr)
    throw new AppError(
      'GH_UNAVAILABLE',
      `The GitHub CLI couldn't create the repository${first ? `: ${first}` : '.'}`
    )
  }
  const [viewed, protocol] = await Promise.all([
    run(['repo', 'view', `${login}/${name}`, '--json', 'sshUrl,url']),
    protocolOf(run)
  ])
  let url: string | null = null
  try {
    url = cloneUrl(
      z.object({ sshUrl: z.string(), url: z.string() }).parse(JSON.parse(text(viewed) ?? '')),
      protocol
    )
  } catch {
    // Reported below.
  }
  if (!url) {
    throw new AppError(
      'GH_UNAVAILABLE',
      'The repository was created, but its URL could not be read. Select it as an existing one.'
    )
  }
  return url
}
