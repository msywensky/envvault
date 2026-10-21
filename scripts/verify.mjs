// `npm run check`: lint and both typechecks in parallel, then the tests,
// printing only failures and a short summary.
//
//   npm run check                                  everything
//   npm run check -- --no-test                     lint and typecheck only
//   npm run check -- tests/paths.test.ts -t pull   filters passed on to vitest
//   node scripts/verify.mjs --list                 the commands, as JSON
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CHECKS, runCheck, typeErrors } from './checks.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MAX_LINES = 40

const args = process.argv.slice(2)
if (args.includes('--list')) {
  process.stdout.write(JSON.stringify(CHECKS) + '\n')
  process.exit(0)
}
const noTest = args.includes('--no-test')
const testFilters = args.filter((a) => a !== '--no-test')

function clip(text, max = MAX_LINES) {
  const lines = text.trim().split(/\r?\n/)
  if (lines.length <= max) return lines.join('\n')
  return [...lines.slice(0, max), `... ${lines.length - max} more lines`].join('\n')
}

function seconds(start) {
  return `${Math.round((Date.now() - start) / 100) / 10} s`
}

let failed = false

const start = Date.now()
const [lint, node, web] = await Promise.all([
  runCheck(ROOT, 'lint'),
  runCheck(ROOT, 'typecheck:node'),
  runCheck(ROOT, 'typecheck:web')
])

if (lint.code === 0) {
  console.log('lint ok')
} else {
  failed = true
  console.log(`lint FAILED (npm run lint)\n${clip(lint.output)}`)
}
for (const [name, result] of [
  ['typecheck:node', node],
  ['typecheck:web', web]
]) {
  if (result.code === 0) continue
  failed = true
  console.log(
    `${name} FAILED (npm run ${name})\n${clip(typeErrors(result.output) || result.output)}`
  )
}
if (node.code === 0 && web.code === 0) console.log(`typecheck ok (${seconds(start)})`)

if (failed) {
  if (!noTest) console.log('tests skipped: fix the failures above first')
  process.exit(1)
}
if (noTest) process.exit(0)

const dir = mkdtempSync(join(tmpdir(), 'envvault-check-'))
try {
  process.exitCode = await tests(join(dir, 'vitest.json'))
} finally {
  rmSync(dir, { recursive: true, force: true })
}

async function tests(report) {
  const testStart = Date.now()
  const result = await runCheck(ROOT, 'test', [
    '--reporter=json',
    `--outputFile=${report}`,
    ...testFilters
  ])
  let json
  try {
    json = JSON.parse(readFileSync(report, 'utf8'))
  } catch {
    // No report: vitest itself failed (bad config, no matching files, ...).
    console.log(`tests FAILED (npm test)\n${clip(result.output)}`)
    return 1
  }
  const skipped = (json.numPendingTests ?? 0) + (json.numTodoTests ?? 0)
  const summary = `${json.numPassedTests} passed / ${json.numFailedTests} failed / ${skipped} skipped`
  const problems = []
  for (const file of json.testResults ?? []) {
    const name = relative(ROOT, file.name)
    const failures = (file.assertionResults ?? []).filter((t) => t.status === 'failed')
    for (const t of failures) {
      const first = (t.failureMessages?.[0] ?? '').split('\n')[0]
      problems.push(`- ${name}: ${t.fullName}\n    ${first}`)
    }
    if (failures.length === 0 && file.status === 'failed') {
      problems.push(`- ${name}: ${(file.message ?? 'failed to run').split('\n')[0]}`)
    }
  }
  if (result.code === 0 && problems.length === 0) {
    console.log(`tests ${summary} (${seconds(testStart)})`)
    return 0
  }
  console.log(`tests FAILED: ${summary}`)
  console.log(problems.length > 0 ? clip(problems.join('\n')) : clip(result.output))
  return 1
}
