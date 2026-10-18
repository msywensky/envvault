// A vault in a private git repository. EnvVault keeps a bare mirror of it in
// its settings folder and never checks out a working tree, so nothing the
// remote sends is ever run:
//   <userData>/git-vaults/<16 hex>.git    bare repo; origin is the vault's URL
//   refs/remotes/origin/<branch>          the head we last fetched or pushed
// Only the branch's top-level files count; README.md, directories and other
// files are ignored, and kept untouched by writes.
//
// A snapshot is one commit, the branch's head when it was taken. A write
// commits one changed file on top of a head and pushes it with a lease on
// that head, so it lands only if nobody pushed in between. If somebody did,
// it fetches and tries again on top of their commit, which conflicts only
// if they changed the same file.
import { mkdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { GitRemoteError, isBranchName, parseGitRemote } from '../../core/gitremote'
import { AppError } from '../errors'
import { firstLine, type RunResult } from '../exec'
import { runGit } from '../git'
import { createSerial } from '../mutex'
import { checkPrivate } from './gitprivacy'
import {
  checkName,
  isStoreName,
  StoreConflictError,
  type StoreSnapshot,
  type VaultStore
} from './types'

export interface GitStoreOptions {
  url: string
  branch: string
  /** The bare mirror's folder, created if missing. */
  dir: string
  /** Tests only: allow local paths and file:// remotes, and skip the privacy check. */
  allowLocal?: boolean
  /** How long an ls-remote result is reused, in ms. Default 10 s. */
  cacheMs?: number
  /**
   * Throw an AppError unless the repository is private. Default: the
   * anonymous https check (gitprivacy.ts), or none with `allowLocal`.
   */
  checkPrivacy?: (url: string) => Promise<void>
}

const LS_REMOTE_MS = 10_000
const REMOTE_MS = 30_000
const LOCAL_MS = 30_000
const MAX_OBJECT_BYTES = 8 * 1024 * 1024
const WRITE_ATTEMPTS = 3
const AUTHOR = {
  GIT_AUTHOR_NAME: 'EnvVault',
  GIT_AUTHOR_EMAIL: 'envvault@users.noreply.invalid',
  GIT_COMMITTER_NAME: 'EnvVault',
  GIT_COMMITTER_EMAIL: 'envvault@users.noreply.invalid'
}
// Regular files only: a symlink is a blob too, but its "content" is a path.
const FILE_MODES = new Set(['100644', '100755'])

const UNREACHABLE = "Couldn't reach the vault repository"

interface TreeRecord {
  /** The ls-tree -z record, byte for byte, so mktree gets other files back unchanged. */
  raw: Buffer
  mode: string
  type: string
  oid: string
}

export class GitStore implements VaultStore {
  readonly kind = 'git'
  readonly url: string
  readonly branch: string
  private readonly dir: string
  private readonly allowLocal: boolean
  private readonly cacheMs: number
  /** Why this store can't be used at all (a bad URL or branch in config.json), or null. */
  private readonly invalid: AppError | null
  // Everything that changes the mirror (init, fetch, update-ref, gc, writes).
  private readonly serial = createSerial()
  private ready: Promise<void> | null = null
  private heads: { map: Map<string, string>; at: number } | null = null
  private listing: Promise<Map<string, string>> | null = null
  // Bumped whenever we learn a newer head ourselves (a push, a fetch), so an
  // ls-remote that started earlier can't replace it with an older one.
  private generation = 0
  private tracked: string | null = null
  private sshCommand: Promise<boolean> | null = null
  private readonly checkPrivacy: ((url: string) => Promise<void>) | null

  constructor(opts: GitStoreOptions) {
    this.url = opts.url
    this.branch = opts.branch
    this.dir = opts.dir
    this.allowLocal = opts.allowLocal ?? false
    this.cacheMs = opts.cacheMs ?? 10_000
    this.checkPrivacy = opts.checkPrivacy ?? (this.allowLocal ? null : checkPrivate)
    this.invalid = isBranchName(this.branch)
      ? urlProblem(this.url, this.allowLocal)
      : new AppError('GIT_VAULT_INVALID_URL', 'The vault branch name is not valid.')
  }

  private get tracking(): string {
    return `refs/remotes/origin/${this.branch}`
  }

  async reachable(): Promise<boolean> {
    try {
      await this.listHeads(this.cacheMs)
      return true
    } catch {
      return false
    }
  }

  /**
   * The branch exists (or the repository is empty: a new vault), and the
   * repository is still private, so one made public since is refused.
   */
  async check(): Promise<void> {
    const heads = await this.listHeads(0)
    if (heads.size > 0 && !heads.has(this.branch)) {
      throw new AppError(
        'GIT_VAULT_BRANCH_MISSING',
        `The vault repository has no "${this.branch}" branch. Choose the repository again in Setup.`
      )
    }
    await this.checkPrivacy?.(this.url)
  }

  /** Everything at the top of the branch, for checking what a repository holds. */
  async topLevel(): Promise<{ name: string; file: boolean }[]> {
    const head = await this.serial(() => this.headLocked(0))
    if (!head) return []
    return [...(await this.readTree(head))].map(([name, r]) => ({ name, file: isFile(r) }))
  }

  async snapshot(): Promise<StoreSnapshot> {
    const head = await this.serial(() => this.headLocked(this.cacheMs))
    const tree = head ? await this.readTree(head) : new Map<string, TreeRecord>()
    const files = new Map([...tree].filter(([name, r]) => isFile(r) && isStoreName(name)))
    return {
      names: [...files.keys()],
      get: async (name) => {
        checkName(name)
        const record = files.get(name)
        if (!record) return null
        const bytes = await this.local(['cat-file', 'blob', record.oid], {
          maxBytes: MAX_OBJECT_BYTES
        })
        return { bytes, version: record.oid }
      }
    }
  }

  async write(name: string, bytes: Uint8Array, expected: string | null): Promise<string> {
    checkName(name)
    // Copied now: the caller may wipe its buffer once this resolves, or reuse it.
    const data = Buffer.from(bytes)
    return this.serial(async () => {
      let head = await this.headLocked(this.cacheMs)
      for (let attempt = 1; ; attempt++) {
        const tree = head ? await this.readTree(head) : new Map<string, TreeRecord>()
        const current = tree.get(name)
        if ((current && isFile(current) ? current.oid : null) !== expected) {
          throw new StoreConflictError()
        }
        const blob = (
          await this.local(['hash-object', '-w', '--no-filters', '--stdin'], { input: data })
        )
          .toString('utf8')
          .trim()
        const commit = await this.commit(tree, name, blob, head)
        if (await this.push(commit, head)) {
          await this.track(commit)
          this.learned(commit)
          return blob
        }
        // Someone pushed first: build on their commit instead.
        if (attempt === WRITE_ATTEMPTS) throw new StoreConflictError()
        head = await this.headLocked(0)
      }
    })
  }

  async cleanUp(): Promise<void> {
    await this.serial(async () => {
      await this.init()
      await this.local(['gc', '--auto', '--quiet'])
    })
  }

  // ---------------------------------------------------------------------------

  /** The remote's branches and their heads. Throws GIT_VAULT_UNREACHABLE. */
  private async listHeads(maxAgeMs: number): Promise<Map<string, string>> {
    if (this.heads && Date.now() - this.heads.at < maxAgeMs) return this.heads.map
    // A forced refresh must start after whatever made it necessary.
    if (maxAgeMs > 0 && this.listing) return this.listing
    const listing = this.lsRemote().finally(() => {
      if (this.listing === listing) this.listing = null
    })
    this.listing = listing
    return listing
  }

  private async lsRemote(): Promise<Map<string, string>> {
    const generation = this.generation
    await this.init()
    const result = await this.git(['ls-remote', '--heads', 'origin'], {
      remote: true,
      timeoutMs: LS_REMOTE_MS
    })
    if (result.code !== 0) throw unreachable(result)
    const map = new Map<string, string>()
    for (const line of result.stdout.toString('utf8').split('\n')) {
      const m = /^([0-9a-f]{40,64})\trefs\/heads\/(.+)$/.exec(line)
      if (m?.[1] && m[2]) map.set(m[2], m[1])
    }
    if (generation === this.generation) this.heads = { map, at: Date.now() }
    return map
  }

  /** Remember the branch's head, newer than anything listed so far. */
  private learned(head: string): void {
    this.generation++
    this.heads = { map: new Map(this.heads?.map).set(this.branch, head), at: Date.now() }
  }

  /**
   * The branch's head, with its objects fetched, or null if there is no
   * branch (an empty repository). Only inside serial().
   */
  private async headLocked(maxAgeMs: number): Promise<string | null> {
    let head = (await this.listHeads(maxAgeMs)).get(this.branch) ?? null
    if (head === null) return null
    if (!(await this.hasCommit(head))) {
      const fetched = await this.git(
        [
          'fetch',
          '--quiet',
          '--no-tags',
          '--no-write-fetch-head',
          'origin',
          `+refs/heads/${this.branch}:${this.tracking}`
        ],
        { remote: true, timeoutMs: REMOTE_MS }
      )
      if (fetched.code !== 0) throw unreachable(fetched)
      // It may have moved again since ls-remote: what was fetched is newer.
      head = (await this.local(['rev-parse', '--verify', this.tracking])).toString('utf8').trim()
      this.tracked = head
      this.learned(head)
    }
    await this.track(head)
    return head
  }

  /** Point the tracking ref at `commit`, which keeps its objects from gc. */
  private async track(commit: string): Promise<void> {
    if (this.tracked === commit) return
    await this.local(['update-ref', this.tracking, commit])
    this.tracked = commit
  }

  private async hasCommit(oid: string): Promise<boolean> {
    return (await this.git(['cat-file', '-e', `${oid}^{commit}`])).code === 0
  }

  private async readTree(commit: string): Promise<Map<string, TreeRecord>> {
    const out = await this.local(['ls-tree', '-z', commit], { maxBytes: MAX_OBJECT_BYTES })
    const tree = new Map<string, TreeRecord>()
    let start = 0
    while (start < out.length) {
      let end = out.indexOf(0, start)
      if (end === -1) end = out.length
      const raw = out.subarray(start, end)
      start = end + 1
      const tab = raw.indexOf(9)
      if (tab === -1) continue
      const [mode, type, oid] = raw.subarray(0, tab).toString('latin1').split(' ')
      if (!mode || !type || !oid) continue
      tree.set(raw.subarray(tab + 1).toString('utf8'), { raw: Buffer.from(raw), mode, type, oid })
    }
    return tree
  }

  /** A commit of `tree` with `name` set to `blob`, everything else as it was. */
  private async commit(
    tree: Map<string, TreeRecord>,
    name: string,
    blob: string,
    parent: string | null
  ): Promise<string> {
    const records = [...tree].filter(([n]) => n !== name).map(([, r]) => r.raw)
    records.push(Buffer.from(`100644 blob ${blob}\t${name}`, 'utf8'))
    const input = Buffer.concat(records.flatMap((r) => [r, Buffer.from([0])]))
    const newTree = (await this.local(['mktree', '-z'], { input })).toString('utf8').trim()
    const args = ['commit-tree', '--no-gpg-sign', '-m', 'EnvVault update']
    if (parent) args.push('-p', parent)
    args.push(newTree)
    return (await this.local(args, { env: AUTHOR })).toString('utf8').trim()
  }

  /**
   * Push `commit` as the branch, only if the branch is still at `head` (or
   * still missing). True if it landed, false if someone pushed first.
   */
  private async push(commit: string, head: string | null): Promise<boolean> {
    const ref = `refs/heads/${this.branch}`
    const result = await this.git(
      [
        '-c',
        'push.gpgSign=false',
        'push',
        '--porcelain',
        '--no-verify',
        `--force-with-lease=${ref}:${head ?? ''}`,
        'origin',
        `${commit}:${ref}`
      ],
      { remote: true, timeoutMs: REMOTE_MS }
    )
    // Porcelain: "<flag>\t<from>:<to>\t<summary>"; "!" means it didn't land.
    const status = result.stdout
      .toString('utf8')
      .split('\n')
      .find((line) => line.split('\t')[1]?.endsWith(`:${ref}`))
    if (!status) throw unreachable(result)
    if (!status.startsWith('!')) return true
    const summary = status.split('\t')[2] ?? ''
    // Refused by the server (branch protection, a hook): trying again won't help.
    if (summary.startsWith('[remote rejected]')) {
      const reason = /\((.*)\)/.exec(summary)?.[1]
      throw new AppError(
        'GIT_ERROR',
        `The vault repository refused the push${reason ? ` (${reason})` : ''}.`
      )
    }
    return false
  }

  // ---------------------------------------------------------------------------

  /** Create the bare mirror once. Its config only ever names origin. */
  private init(): Promise<void> {
    if (this.invalid) return Promise.reject(this.invalid)
    this.ready ??= (async () => {
      await mkdir(join(this.dir, 'no-hooks'), { recursive: true })
      if (!(await exists(join(this.dir, 'config')))) {
        await this.local(['init', '--bare', '--quiet', '--template='])
      }
      await this.local(['config', 'remote.origin.url', this.url])
      const tracked = await this.git(['rev-parse', '--verify', '--quiet', this.tracking])
      this.tracked = tracked.code === 0 ? tracked.stdout.toString('utf8').trim() : null
    })().catch((err: unknown) => {
      this.ready = null
      throw err
    })
    return this.ready
  }

  /** Whether your git config sets core.sshCommand. Asked once, after init. */
  private hasSshCommand(): Promise<boolean> {
    this.sshCommand ??= sshCommandSet(['--git-dir', this.dir], this.dir)
    return this.sshCommand
  }

  private async git(args: string[], opts: GitOptions = {}): Promise<RunResult> {
    const hooks = join(this.dir, 'no-hooks')
    return runGit(['--git-dir', this.dir, ...hardening(this.allowLocal, hooks), ...args], {
      cwd: this.dir,
      env: await vaultEnv(opts, () => this.hasSshCommand()),
      input: opts.input,
      timeoutMs: opts.timeoutMs ?? LOCAL_MS,
      maxBytes: opts.maxBytes
    })
  }

  /** A command in the mirror that must succeed. */
  private async local(args: string[], opts: GitOptions = {}): Promise<Buffer> {
    const result = await this.git(args, opts)
    if (result.code === 0) return result.stdout
    const first = result.failure ? describeFailure(result) : firstLine(result.stderr)
    throw new AppError('GIT_ERROR', `git ${args[0]} failed${first ? `: ${first}` : '.'}`)
  }
}

interface GitOptions {
  input?: Uint8Array
  timeoutMs?: number
  maxBytes?: number
  env?: Record<string, string>
  /** It talks to the remote (so it may run ssh). */
  remote?: boolean
}

const REDIRECTS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE',
  'GIT_COMMON_DIR'
]

/** -c settings for every vault command. */
function hardening(allowLocal: boolean, hooksDir: string | null): string[] {
  const protocols = ['https', 'ssh', ...(allowLocal ? ['file'] : [])]
  return [
    '-c',
    'core.fsmonitor=false',
    // Your global hooks (a pre-push scanner, say) don't run on our pushes.
    ...(hooksDir ? ['-c', `core.hooksPath=${hooksDir}`] : []),
    '-c',
    'protocol.allow=never',
    ...protocols.flatMap((p) => ['-c', `protocol.${p}.allow=always`]),
    '-c',
    'fetch.fsckObjects=true',
    '-c',
    'transfer.fsckObjects=true'
  ]
}

async function vaultEnv(
  opts: GitOptions,
  hasSshCommand: () => Promise<boolean>
): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    LC_ALL: 'C',
    ...opts.env
  }
  // --git-dir is the only repository; nothing inherited redirects its parts.
  for (const name of REDIRECTS) delete env[name]
  // Setting GIT_SSH_COMMAND would override your core.sshCommand (1Password,
  // Windows OpenSSH), so it's only set when you have none.
  if (opts.remote && !env['GIT_SSH_COMMAND'] && !env['GIT_SSH'] && !(await hasSshCommand())) {
    env['GIT_SSH_COMMAND'] = 'ssh -o BatchMode=yes'
  }
  return env
}

/** Whether git config (system, global, and the repository's in `prefix`) sets core.sshCommand. */
function sshCommandSet(prefix: string[], cwd: string): Promise<boolean> {
  return runGit([...prefix, 'config', '--get', 'core.sshCommand'], {
    cwd,
    env: process.env,
    timeoutMs: LOCAL_MS
  }).then(
    (r) => r.code === 0 && r.stdout.toString('utf8').trim() !== '',
    () => false
  )
}

function urlProblem(url: string, allowLocal: boolean): AppError | null {
  if (allowLocal) return null
  try {
    parseGitRemote(url)
    return null
  } catch (err) {
    if (err instanceof GitRemoteError) return new AppError('GIT_VAULT_INVALID_URL', err.message)
    throw err
  }
}

/**
 * The repository's default branch, asked with your own credentials (so this
 * also proves you can reach it), or "main" for an empty repository. `cwd`
 * must not be inside a repository.
 */
export async function defaultBranch(
  url: string,
  cwd: string,
  opts: { allowLocal?: boolean } = {}
): Promise<string> {
  const problem = urlProblem(url, opts.allowLocal ?? false)
  if (problem) throw problem
  const result = await runGit(
    [...hardening(opts.allowLocal ?? false, null), 'ls-remote', '--symref', url, 'HEAD'],
    {
      cwd,
      env: await vaultEnv({ remote: true }, () => sshCommandSet([], cwd)),
      timeoutMs: LS_REMOTE_MS
    }
  )
  if (result.code !== 0) throw unreachable(result)
  const head = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(result.stdout.toString('utf8'))?.[1]
  if (!head) return 'main'
  if (!isBranchName(head)) {
    throw new AppError(
      'GIT_ERROR',
      "The repository's default branch has a name EnvVault doesn't use."
    )
  }
  return head
}

const isFile = (r: TreeRecord): boolean => r.type === 'blob' && FILE_MODES.has(r.mode)

function describeFailure(result: RunResult): string {
  if (result.failure === 'timeout') return 'timed out'
  if (result.failure === 'too-large') return 'too much output'
  return firstLine(result.stderr)
}

function unreachable(result: RunResult): AppError {
  const why = describeFailure(result).replace(/\.$/, '')
  return new AppError('GIT_VAULT_UNREACHABLE', `${UNREACHABLE}${why ? ` (${why})` : ''}.`)
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}
