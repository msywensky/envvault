// The scope of a branch review, for the /ev-review and /ev-security skills:
// the base (the PR's base branch, so a stacked PR is reviewed against its
// parent), every changed file including untracked ones, each file's class,
// and which reviewers to launch. Classification is by path, never by whether
// cymbal found symbols: cymbal doesn't index .vue, and config can be
// security-relevant (docs/claude-orchestration-plan.md, 8.1).
//
//   node scripts/review-scope.mjs          text summary
//   node scripts/review-scope.mjs --json   the same as JSON
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const SECURITY = [
  /^electron\.vite\.config\.ts$/, // CSP
  /^electron-builder\.yml$/, // fuses
  /^build\//, // entitlements
  /^resources\//,
  /^vite\.cli\.config\.mts$/,
  /^eslint\.config\.mjs$/, // import bans
  /^package(-lock)?\.json$/,
  /^\.github\//,
  /^\.husky\//,
  /^\.gitignore$/, // keeps .env out of git
  /^scripts\/deploy-/,
  /^scripts\/claude-hook\.mjs$/, // the agent guardrails themselves
  /^\.claude\//,
  /^\.opencode\//,
  /^opencode\.json$/,
  /^tests\/fixtures\//,
  /^docs\/security\.md$/
]
// First match wins. Markdown is docs wherever it lives (CLAUDE.md files sit next to the code).
const CLASSES = [
  ['security', SECURITY],
  ['docs', [/\.md$/]],
  ['code', [/^src\//, /^scripts\//]],
  [
    'config',
    [/^tsconfig.*\.json$/, /^vitest\.config\.mts$/, /^\.prettierrc\.yaml$/, /^\.gitattributes$/]
  ],
  ['tests', [/^tests\//]],
  ['docs', [/^docs\//, /\.(png|jpe?g|gif|svg|webp)$/]]
]
const IPC = [/^src\/shared\//, /^src\/main\/(schemas|handlers|ipc)\.ts$/, /^src\/preload\//]
const SYNC = [
  /^src\/main\/(sync|autopull|bases|vault|repos|mutex|session|state|localkeys|mini|git|gitvault)\.ts$/,
  /^src\/main\/store\//,
  /^src\/core\/env(merge|edit|diff|lines)\.ts$/
]

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim() : null
}
const git = (...args) => run('git', ['-c', 'core.fsmonitor=false', ...args])

function findBase() {
  const prBase = run('gh', ['pr', 'view', '--json', 'baseRefName', '-q', '.baseRefName'])
  if (prBase) {
    const fetched = git('fetch', '--quiet', 'origin', prBase) !== null
    const base =
      (fetched && git('merge-base', `origin/${prBase}`, 'HEAD')) ||
      git('merge-base', prBase, 'HEAD')
    if (base) return { ref: prBase, sha: base, note: fetched ? '' : ' (not fetched: offline?)' }
  }
  const main = git('merge-base', 'origin/main', 'HEAD')
  if (main)
    return { ref: 'main', sha: main, note: prBase ? ` (PR base ${prBase} not found)` : ' (no PR)' }
  return null
}

const base = findBase()
if (!base) {
  console.error('Cannot determine the review base (no PR base, no origin/main).')
  process.exit(1)
}
const top = git('rev-parse', '--show-toplevel')
process.chdir(top)

const lines = (s) => (s ? s.split('\n').filter(Boolean) : [])
const tracked = lines(git('diff', '--name-status', base.sha)).map((l) => {
  const [status, ...paths] = l.split('\t')
  return { status: status[0], path: paths[paths.length - 1] }
})
const untracked = lines(git('ls-files', '--others', '--exclude-standard')).map((path) => ({
  status: '?',
  path
}))
const files = [...tracked, ...untracked].map((f) => ({
  ...f,
  class: CLASSES.find(([, res]) => res.some((re) => re.test(f.path)))?.[0] ?? 'other'
}))

const touches = (res) => files.some((f) => f.class !== 'docs' && res.some((re) => re.test(f.path)))
// A renderer change matters to IPC when it touches window.envvault calls.
const rendererCallsApi = files.some((f) => {
  if (!/^src\/renderer\//.test(f.path) || f.status === 'D') return false
  const text = f.status === '?' ? readFileSync(f.path, 'utf8') : git('diff', base.sha, '--', f.path)
  return /window\.envvault/.test(text ?? '')
})

const docsOnly = files.length > 0 && files.every((f) => f.class === 'docs')
const reviewers = []
if (files.length > 0 && !docsOnly) reviewers.push('security-reviewer')
if (touches(IPC) || rendererCallsApi) reviewers.push('ipc-reviewer')
if (touches(SYNC)) reviewers.push('sync-reviewer')

const cymbal = run(process.platform === 'win32' ? 'where' : 'which', ['cymbal']) !== null

const scope = {
  base: { ref: base.ref, sha: base.sha, note: base.note.trim() },
  files,
  docsOnly,
  reviewers,
  cymbal,
  untrackedNote:
    untracked.length > 0
      ? 'untracked files have no git diff or cymbal symbols: read them whole'
      : null
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(scope, null, 2))
} else {
  console.log(`base: ${base.ref} @ ${base.sha.slice(0, 12)}${base.note}`)
  console.log(`files (${files.length}):`)
  for (const f of files) console.log(`  ${f.status} ${f.class.padEnd(8)} ${f.path}`)
  if (files.length === 0) console.log('  (none)')
  console.log(`reviewers: ${reviewers.join(', ') || (docsOnly ? 'none (docs only)' : 'none')}`)
  if (scope.untrackedNote) console.log(`note: ${scope.untrackedNote}`)
  console.log(
    cymbal
      ? `symbols: cymbal changed --base ${base.sha} --no-federate`
      : 'symbols: cymbal not on PATH; review from the file list and git diff alone, and say so'
  )
}
