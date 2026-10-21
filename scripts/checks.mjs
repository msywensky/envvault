// The repository checks, run straight from each package's bin with the
// current Node: no npm.cmd/npx.cmd (Node 22 refuses to spawn .cmd files
// without a shell on Windows) and no shell at all. Shared by verify.mjs
// (`npm run check`) and claude-hook.mjs (the Stop typecheck), so both run
// exactly what the package.json scripts run; tests/claude-hook.test.ts keeps
// the two in sync.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const BINS = {
  eslint: 'eslint/bin/eslint.js',
  tsc: 'typescript/bin/tsc',
  'vue-tsc': 'vue-tsc/bin/vue-tsc.js',
  vitest: 'vitest/vitest.mjs'
}

/** Each check as [package.json script, program, args]. */
export const CHECKS = {
  lint: ['lint', 'eslint', ['--cache', '--max-warnings', '0', '.']],
  'typecheck:node': [
    'typecheck:node',
    'tsc',
    ['--noEmit', '-p', 'tsconfig.node.json', '--composite', 'false']
  ],
  'typecheck:web': [
    'typecheck:web',
    'vue-tsc',
    ['--noEmit', '-p', 'tsconfig.web.json', '--composite', 'false']
  ],
  test: ['test', 'vitest', ['run']]
}

export function binPath(root, program) {
  return join(root, 'node_modules', BINS[program])
}

export function hasDeps(root) {
  return existsSync(binPath(root, 'eslint'))
}

/** Runs one program from root's node_modules; resolves with its exit code and output. */
export function run(root, program, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [binPath(root, program), ...args], {
      cwd: root,
      env: { ...process.env, FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let output = ''
    child.stdout.on('data', (d) => (output += d))
    child.stderr.on('data', (d) => (output += d))
    child.on('error', (err) =>
      resolve({ code: 1, output: `${err.name}: could not start ${program}` })
    )
    child.on('close', (code) => resolve({ code: code ?? 1, output }))
  })
}

export function runCheck(root, name, extraArgs = []) {
  const [, program, args] = CHECKS[name]
  return run(root, program, [...args, ...extraArgs])
}

/** Keeps the TypeScript error lines (not the summary or code frames), at most `max`. */
export function typeErrors(output, max = 20) {
  const lines = output.split(/\r?\n/).filter((l) => /error TS\d+/.test(l))
  const more = lines.length > max ? [`... and ${lines.length - max} more`] : []
  return [...lines.slice(0, max), ...more].join('\n')
}

/** Both typechecks in parallel; ok only if both pass. */
export async function typecheck(root) {
  const results = await Promise.all([
    runCheck(root, 'typecheck:node'),
    runCheck(root, 'typecheck:web')
  ])
  const failed = results.filter((r) => r.code !== 0)
  return {
    ok: failed.length === 0,
    output: failed.map((r) => typeErrors(r.output) || r.output.trim()).join('\n')
  }
}
