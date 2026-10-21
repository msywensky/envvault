// Creates (or finishes setting up) a worktree under .claude/worktrees/, the
// folder Claude Code's own `claude --worktree` uses, so `npm run check`,
// pre-commit and cymbal all work there.
//
//   node scripts/worktree.mjs <slug>                 new branch <slug> from HEAD
//   node scripts/worktree.mjs <slug> <branch>        existing or new branch
//   node scripts/worktree.mjs <slug> --setup-only    a worktree that already exists
//
// Setup is `npm ci --ignore-scripts` (no Electron download, so `npm run dev`
// won't work there; `npm run check` will), then `npm run prepare`: Husky's
// core.hooksPath (.husky/_) is relative to each worktree and generated, so
// without it pre-commit silently does nothing. Then a cymbal index with the
// build output excluded.
import { spawnSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SLUG = /^[a-z0-9][a-z0-9-]*$/

function fail(message) {
  console.error(message)
  process.exit(1)
}

function step(label, cmd, args, cwd) {
  console.log(`> ${label}`)
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit' })
  if (r.error) fail(`${label}: ${r.error.name}`)
  if (r.status !== 0) fail(`${label} failed (exit ${r.status})`)
}

const git = (args, cwd = ROOT) =>
  spawnSync('git', ['-c', 'core.fsmonitor=false', ...args], { cwd, encoding: 'utf8' })

/** npm's CLI script, run with this Node: never npm.cmd, which Node 22 won't spawn without a shell. */
function npmCli() {
  const candidates = [process.env['npm_execpath']]
  // npm on PATH: a symlink to npm-cli.js (macOS, Linux), or npm.cmd beside node_modules (Windows).
  const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['npm'], {
    encoding: 'utf8'
  })
  for (const p of which.status === 0 ? which.stdout.split(/\r?\n/).filter(Boolean) : []) {
    try {
      candidates.push(realpathSync(p))
    } catch {
      // dangling link
    }
    candidates.push(join(dirname(p), 'node_modules', 'npm', 'bin', 'npm-cli.js'))
  }
  candidates.push(join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'))
  const found = candidates.find((p) => p && /npm-cli\.js$/.test(p) && existsSync(p))
  if (!found) fail('Could not find npm-cli.js next to this Node; run through `npm exec` instead.')
  return found
}

const args = process.argv.slice(2)
const setupOnly = args.includes('--setup-only')
const [slug, branchArg] = args.filter((a) => !a.startsWith('--'))
if (!slug || !SLUG.test(slug)) {
  fail('Usage: node scripts/worktree.mjs <slug> [branch] [--setup-only] (slug: a-z, 0-9, dashes)')
}
const dir = join(ROOT, '.claude', 'worktrees', slug)

if (existsSync(dir)) {
  console.log(`Worktree ${dir} exists; setting it up.`)
} else if (setupOnly) {
  fail(`No worktree at ${dir}.`)
} else {
  const branch = branchArg ?? slug
  const exists = git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).status === 0
  step(
    `git worktree add ${exists ? '' : '-b '}${branch}`,
    'git',
    ['worktree', 'add', ...(exists ? [dir, branch] : ['-b', branch, dir])],
    ROOT
  )
}

const npm = npmCli()
step('npm ci --ignore-scripts', process.execPath, [npm, 'ci', '--ignore-scripts'], dir)
step('npm run prepare (Husky)', process.execPath, [npm, 'run', 'prepare'], dir)
if (spawnSync(process.platform === 'win32' ? 'where' : 'which', ['cymbal']).status === 0) {
  step('cymbal index', 'cymbal', ['index', '.', '--exclude', 'out/**', '--exclude', 'dist/**'], dir)
} else {
  console.log('cymbal not on PATH; skipping the index.')
}

const branch = git(['branch', '--show-current'], dir).stdout.trim()
console.log(`\nWorktree: ${dir}\nBranch:   ${branch}`)
