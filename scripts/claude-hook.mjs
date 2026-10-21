// Claude Code hooks for this repo (wired in .claude/settings.json):
//
//   lint-file   PostToolUse(Edit|Write): ESLint the file just edited
//   guard       PreToolUse(Bash|PowerShell): block env file reads and destructive commands
//   typecheck   Stop: typecheck, only after this session edited code
//
// Reads the hook's JSON on stdin. Exit 2 blocks (or, after the fact, reports)
// with stderr as the message Claude sees. The guard is a seatbelt, not a
// boundary: docs/claude-orchestration-plan.md (6.4) lists what it misses.
import { spawnSync } from 'node:child_process'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { binPath, hasDeps, typecheck } from './checks.mjs'

const LINTED = new Set(['.ts', '.mts', '.vue', '.js', '.mjs'])
const TYPED = new Set(['.ts', '.mts', '.vue'])
const RECORDS = join(tmpdir(), 'envvault-claude')
const SCRIPT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

// ---- shared ----

function readInput() {
  try {
    return JSON.parse(readFileSync(0, 'utf8') || '{}')
  } catch {
    return {}
  }
}

function block(reason) {
  process.stderr.write(`${reason}\n`)
  process.exit(2)
}

/** Non-blocking note: systemMessage for the user, and for PostToolUse additionalContext for Claude. */
function note(event, text) {
  const out = { systemMessage: text }
  if (event === 'PostToolUse') {
    out.hookSpecificOutput = { hookEventName: event, additionalContext: text }
  }
  process.stdout.write(JSON.stringify(out))
  process.exit(0)
}

function git(cwd, args) {
  const r = spawnSync('git', ['-c', 'core.fsmonitor=false', ...args], { cwd, encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim() : null
}

/** The worktree containing dir, if it belongs to the same repository as this script. */
function worktreeOf(dir) {
  if (!existsSync(dir)) return null
  const top = git(dir, ['rev-parse', '--show-toplevel'])
  if (!top) return null
  const common = (d) => {
    const c = git(d, ['rev-parse', '--git-common-dir'])
    return c && realpathSync(resolve(d, c))
  }
  const ours = common(SCRIPT_ROOT)
  return ours && samePath(common(top), ours) ? resolve(top) : null
}

/** Path equality; Windows paths compare case-insensitively (git and Node disagree on drive-letter case). */
const samePath = (a, b) =>
  process.platform === 'win32'
    ? resolve(a).toLowerCase() === resolve(b).toLowerCase()
    : resolve(a) === resolve(b)

const safeId = (id) => String(id ?? '').replace(/[^A-Za-z0-9_-]/g, '_')

// ---- lint-file ----

function lintFile(input) {
  const filePath = input.tool_input?.file_path
  if (typeof filePath !== 'string' || filePath === '') return
  const cwd = input.cwd || process.cwd()
  const abs = resolve(cwd, filePath)
  if (!LINTED.has(extname(abs))) return
  const root = worktreeOf(dirname(abs))
  if (!root) return
  const rel = relative(root, abs)
  if (rel.startsWith('..') || isAbsolute(rel)) return
  if (rel.split(sep).some((part) => ['node_modules', 'out', 'dist'].includes(part))) return

  if (input.session_id) {
    mkdirSync(RECORDS, { recursive: true })
    const file = join(
      RECORDS,
      `${safeId(input.session_id)}-${safeId(input.agent_id || 'main')}.jsonl`
    )
    // One appended line per edit: atomic for small writes, so parallel edits don't lose records.
    appendFileSync(file, JSON.stringify({ path: abs, root }) + '\n')
  }

  if (!hasDeps(root)) {
    note('PostToolUse', `lint skipped: no node_modules in ${root} (run scripts/worktree.mjs there)`)
  }
  const r = spawnSync(
    process.execPath,
    [binPath(root, 'eslint'), '--max-warnings', '0', '--no-cache', '--format', 'json', rel],
    { cwd: root, encoding: 'utf8' }
  )
  if (r.status === 0) return
  let results
  try {
    results = JSON.parse(r.stdout)
  } catch {
    block(`ESLint failed to run on ${rel}:\n${(r.stderr || r.stdout).trim().slice(0, 2000)}`)
  }
  const messages = results.flatMap((f) => f.messages)
  if (messages.length === 0) return
  if (messages.every((m) => m.ruleId === 'prettier/prettier')) {
    note('PostToolUse', `${rel}: formatting only; run \`npx prettier --write ${rel}\``)
  }
  const lines = messages
    .slice(0, 20)
    .map((m) => `${rel}:${m.line}:${m.column} ${m.message} (${m.ruleId ?? 'parse'})`)
  if (messages.length > 20) lines.push(`... and ${messages.length - 20} more`)
  block(`ESLint (--max-warnings 0) on ${rel}:\n${lines.join('\n')}`)
}

// ---- typecheck ----

async function typecheckStop(input) {
  if (input.stop_hook_active || !input.session_id) return
  if (!existsSync(RECORDS)) return
  const prefix = `${safeId(input.session_id)}-`
  const files = readdirSync(RECORDS)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.jsonl'))
    .map((f) => join(RECORDS, f))
  const roots = new Set()
  for (const file of files) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      try {
        const rec = JSON.parse(line)
        if (TYPED.has(extname(rec.path))) roots.add(rec.root)
      } catch {
        // blank or partial line
      }
    }
  }
  if (roots.size === 0) {
    for (const file of files) rmSync(file, { force: true })
    return
  }

  const skipped = []
  const failures = []
  for (const root of roots) {
    if (!hasDeps(root)) {
      skipped.push(root)
      continue
    }
    const result = await typecheck(root)
    if (!result.ok) failures.push(roots.size > 1 ? `${root}:\n${result.output}` : result.output)
  }
  if (failures.length > 0) block(`Typecheck failed:\n${failures.join('\n')}`)
  for (const file of files) rmSync(file, { force: true })
  if (skipped.length > 0) {
    note('Stop', `typecheck skipped: no node_modules in ${skipped.join(', ')}`)
  }
}

// ---- guard ----

/**
 * Splits a command line into segments (simple commands), each a list of
 * argument values with quotes and escapes resolved. $(...) and backtick
 * bodies, `bash -c` strings and subshells become segments of their own;
 * heredoc bodies and comments are skipped (they are data, not commands).
 * PowerShell differs in its escape character (`) and in having no heredocs.
 */
export function segments(command, shell = 'bash') {
  const ps = shell === 'powershell'
  const esc = ps ? '`' : '\\'
  const out = []
  let seg = []
  let tok = null
  let i = 0
  const pendingHeredocs = []

  const endTok = () => {
    if (tok !== null) seg.push(tok)
    tok = null
  }
  const endSeg = () => {
    endTok()
    if (seg.length > 0) out.push(seg)
    seg = []
  }
  const add = (s) => (tok = (tok ?? '') + s)

  // Reads a balanced $( ... ) or ( ... ) body starting after the opening paren.
  const balanced = () => {
    let depth = 1
    let j = i
    let quote = null
    for (; j < command.length; j++) {
      const c = command[j]
      if (quote) {
        if (c === quote) quote = null
        else if (c === esc && quote === '"') j++
        continue
      }
      if (c === "'" || c === '"') quote = c
      else if (c === esc) j++
      else if (c === '(') depth++
      else if (c === ')' && --depth === 0) break
    }
    const body = command.slice(i, j)
    i = j + 1
    return body
  }
  const nested = (body) => out.push(...segments(body, shell))

  while (i < command.length) {
    const c = command[i]
    const next = command[i + 1]

    if (c === '\n' && pendingHeredocs.length > 0) {
      // Skip each heredoc body up to its delimiter line.
      i++
      for (const { word, strip } of pendingHeredocs.splice(0)) {
        while (i < command.length) {
          const eol = command.indexOf('\n', i)
          const line = command.slice(i, eol === -1 ? command.length : eol)
          i = eol === -1 ? command.length : eol + 1
          if ((strip ? line.replace(/^\t+/, '') : line) === word) break
        }
      }
      endSeg()
      continue
    }
    if (/\s/.test(c)) {
      if (c === '\n') endSeg()
      else endTok()
      i++
      continue
    }
    if (c === '#' && tok === null) {
      while (i < command.length && command[i] !== '\n') i++
      continue
    }
    if (c === "'") {
      const end = command.indexOf("'", i + 1)
      add(command.slice(i + 1, end === -1 ? command.length : end))
      i = end === -1 ? command.length : end + 1
      continue
    }
    if (c === '"') {
      i++
      let s = ''
      while (i < command.length && command[i] !== '"') {
        const d = command[i]
        if (d === esc && i + 1 < command.length) {
          const e = command[i + 1]
          // bash keeps the backslash unless it escapes $ ` " \ or newline
          s += ps || '$`"\\\n'.includes(e) ? e : d + e
          i += 2
        } else if (d === '$' && command[i + 1] === '(') {
          i += 2
          nested(balanced())
        } else if (!ps && d === '`') {
          const end = command.indexOf('`', i + 1)
          nested(command.slice(i + 1, end === -1 ? command.length : end))
          i = end === -1 ? command.length : end + 1
        } else {
          s += d
          i++
        }
      }
      i++
      add(s)
      continue
    }
    if (c === esc && i + 1 < command.length) {
      add(command[i + 1])
      i += 2
      continue
    }
    if (c === '$' && next === '(') {
      i += 2
      nested(balanced())
      add('')
      continue
    }
    if (!ps && c === '`') {
      const end = command.indexOf('`', i + 1)
      nested(command.slice(i + 1, end === -1 ? command.length : end))
      i = end === -1 ? command.length : end + 1
      add('')
      continue
    }
    if (c === '(' || c === ')' || c === '{' || c === '}') {
      if (c === '(' && tok === null) {
        i++
        nested(balanced())
        continue
      }
      if ((c === '{' || c === '}') && tok !== null) {
        add(c)
        i++
        continue
      }
      endSeg()
      i++
      continue
    }
    if (c === ';' || c === '|' || c === '&') {
      endSeg()
      i += c === next || (c === '|' && next === '&') ? 2 : 1
      continue
    }
    if (c === '<' || c === '>') {
      endTok()
      if (!ps && c === '<' && next === '<' && command[i + 2] !== '<') {
        // heredoc: << or <<- then the delimiter word (quotes removed)
        i += 2
        const strip = command[i] === '-'
        if (strip) i++
        while (command[i] === ' ' || command[i] === '\t') i++
        const m = /^(['"]?)([^\s'";|&<>()]+)\1/.exec(command.slice(i))
        if (m) {
          pendingHeredocs.push({ word: m[2], strip })
          i += m[0].length
        }
        continue
      }
      let op = c
      i++
      while (command[i] === '<' || command[i] === '>' || command[i] === '&') op += command[i++]
      seg.push(op)
      continue
    }
    add(c)
    i++
  }
  endSeg()
  return out
}

const ENV_FILE = /(^|\/)\.env(\.[\w.-]+)?$/
const ENV_EXAMPLE = /(^|\/)\.env\.example$/

/** True if the argument names an env file: itself, an --opt=value, or a git rev:path. */
export function isEnvPath(arg) {
  const values = [arg]
  const eq = arg.indexOf('=')
  if (arg.startsWith('-') && eq > 0) values.push(arg.slice(eq + 1))
  const colon = arg.lastIndexOf(':')
  if (colon >= 0) values.push(arg.slice(colon + 1))
  return values.some((v) => {
    const p = v.replace(/\\/g, '/')
    return ENV_FILE.test(p) && !ENV_EXAMPLE.test(p)
  })
}

const WRAPPERS = new Set(['sudo', 'env', 'command', 'builtin', 'exec', 'nohup', 'time', 'nice'])
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', 'fi', 'done'])
const GREP = new Set(['grep', 'egrep', 'fgrep', 'rg'])
// Short options that take a value, per program (so the value isn't taken for the pattern).
const VALUE_OPTS = {
  grep: new Set('ABCmdDf'),
  rg: new Set('ABCmMjgtTEfr')
}
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash'])
const POWERSHELLS = new Set(['pwsh', 'powershell'])

function programName(word) {
  return word
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    .toLowerCase()
    .replace(/\.exe$/, '')
}

/** Drops assignments, wrappers and shell keywords in front of the program. */
function strip(seg) {
  let k = 0
  while (k < seg.length) {
    const w = seg[k]
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) || KEYWORDS.has(w)) k++
    else if (WRAPPERS.has(programName(w))) {
      k++
      while (k < seg.length && seg[k].startsWith('-')) k++
    } else break
  }
  return seg.slice(k)
}

const shortFlags = (a) => (/^-[A-Za-z.]+$/.test(a) ? a.slice(1) : '')

/** Index of the grep/rg pattern argument, or -1 when patterns come from -e. */
function patternIndex(words, prog) {
  const valueOpts = VALUE_OPTS[prog === 'rg' ? 'rg' : 'grep']
  if (words.some((w) => w === '-e' || w.startsWith('--regexp') || /^-e./.test(w))) return -1
  for (let k = 1; k < words.length; k++) {
    const w = words[k]
    if (w === '--') return k + 1
    if (w.startsWith('--')) continue
    if (w.startsWith('-') && w.length > 1) {
      const last = w[w.length - 1]
      if (valueOpts.has(last)) k++
      continue
    }
    return k
  }
  return -1
}

/** -e values (the patterns) when -e is used. */
function eValueIndexes(words) {
  const idx = new Set()
  words.forEach((w, k) => {
    if (w === '-e' || w === '--regexp') idx.add(k + 1)
  })
  return idx
}

function checkSegment(words, ctx) {
  const prog = programName(words[0])
  const lower = words.map((w) => w.toLowerCase())

  if (SHELLS.has(prog)) {
    const c = words.indexOf('-c')
    if (c > 0 && words[c + 1] !== undefined) return checkCommand(words[c + 1], 'bash', ctx)
  }
  if (POWERSHELLS.has(prog)) {
    const c = lower.findIndex((w) => w === '-c' || w === '-command')
    if (c > 0 && words[c + 1] !== undefined) return checkCommand(words[c + 1], 'powershell', ctx)
  }

  // Env files, by any program. grep/rg patterns are exempt: this codebase is about .env files.
  const exempt = new Set()
  if (GREP.has(prog)) {
    const p = patternIndex(words, prog)
    if (p > 0) exempt.add(p)
    for (const k of eValueIndexes(words)) exempt.add(k)
  }
  for (let k = 0; k < words.length; k++) {
    if (!exempt.has(k) && isEnvPath(words[k])) {
      return `reads or writes an env file (${words[k]}); env values must not reach the transcript`
    }
  }

  if (prog === 'grep' || prog === 'egrep' || prog === 'fgrep') {
    const recursive = words.some(
      (w) =>
        w === '--recursive' ||
        w === '--dereference-recursive' ||
        /[rR]/.test(shortFlags(w).replace(/[ABCmdDfe].*$/, ''))
    )
    const excluded = words.some((w) => /^--exclude=\.env/.test(w))
    if (recursive && !excluded) {
      const p = patternIndex(words, prog)
      const first = p > 0 ? p + 1 : 1
      const paths = words.slice(first).filter((w) => !w.startsWith('-'))
      const targets = paths.length > 0 ? paths : ['.']
      if (targets.some((t) => samePath(resolve(ctx.cwd, t), ctx.root))) {
        return 'recursive grep over the repo root reads .env files (grep ignores .gitignore); search src/ or tests/, or use rg or the Grep tool'
      }
    }
  }

  if (prog === 'rg') {
    let u = 0
    let hidden = false
    let noIgnore = false
    for (const w of words) {
      if (w === '--hidden') hidden = true
      if (w.startsWith('--no-ignore')) noIgnore = true
      if (w === '--unrestricted') u++
      const f = shortFlags(w)
      u += (f.match(/u/g) ?? []).length
      if (f.includes('.')) hidden = true
    }
    if ((u >= 1 || noIgnore) && (u >= 2 || hidden)) {
      return 'rg with ignore rules off and hidden files on reads .env files'
    }
  }

  if (prog === 'git') {
    let k = 1
    while (k < words.length && words[k].startsWith('-')) {
      if (
        words[k] === '-C' ||
        words[k] === '-c' ||
        words[k] === '--git-dir' ||
        words[k] === '--work-tree'
      )
        k++
      k++
    }
    const sub = words[k]
    const rest = words.slice(k + 1)
    if (sub === 'reset' && rest.includes('--hard')) return 'git reset --hard discards work'
    if (sub === 'clean' && rest.some((w) => w === '--force' || shortFlags(w).includes('f'))) {
      return 'git clean -f deletes untracked files'
    }
    if (sub === 'checkout' && rest.some((w) => w === '.' || w === '--')) {
      return 'git checkout of paths discards changes'
    }
    if (sub === 'restore' && !rest.some((w) => w === '--staged' || w === '-S')) {
      return 'git restore of the working tree discards changes'
    }
    if (
      sub === 'push' &&
      rest.some(
        (w) =>
          w.startsWith('--force') ||
          (shortFlags(w).includes('f') && !w.startsWith('--')) ||
          /^\+./.test(w)
      )
    ) {
      return 'force push'
    }
  }

  if (prog === 'rm' && !ctx.ps) {
    const flags = words.slice(1).filter((w) => w.startsWith('-'))
    const r = flags.some((w) => w === '--recursive' || /[rR]/.test(shortFlags(w)))
    const f = flags.some((w) => w === '--force' || shortFlags(w).includes('f'))
    if (r && f) return 'rm -rf'
  }
  if (
    ['remove-item', 'ri', 'rm', 'del', 'erase', 'rd', 'rmdir'].includes(prog) &&
    ctx.ps &&
    lower.some((w) => /^-r(e(c(u(r(se?)?)?)?)?)?$/.test(w))
  ) {
    return 'Remove-Item -Recurse'
  }

  if (['npm', 'pnpm', 'yarn'].includes(prog) && words[1] === 'publish')
    return 'publishing a package'
  return null
}

function checkCommand(command, shell, ctx) {
  const inner = { ...ctx, ps: shell === 'powershell' }
  for (const raw of segments(command, shell)) {
    const words = strip(raw)
    if (words.length === 0) continue
    const reason = checkSegment(words, inner)
    if (reason) return reason
  }
  return null
}

/** The guard's verdict for a tool call: a reason to block, or null. */
export function guardReason(input) {
  const command = input.tool_input?.command
  if (typeof command !== 'string') return null
  const cwd = resolve(input.cwd || process.cwd())
  const root = git(cwd, ['rev-parse', '--show-toplevel'])
  const ctx = { cwd, root: root ? resolve(root) : cwd }
  return checkCommand(command, input.tool_name === 'PowerShell' ? 'powershell' : 'bash', ctx)
}

function guard(input) {
  const reason = guardReason(input)
  if (reason) block(`Blocked by the envvault guard (scripts/claude-hook.mjs): ${reason}.`)
}

// ---- main ----

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const input = readInput()
  switch (process.argv[2]) {
    case 'lint-file':
      lintFile(input)
      break
    case 'guard':
      guard(input)
      break
    case 'typecheck':
      await typecheckStop(input)
      break
    default:
      block('usage: claude-hook.mjs lint-file|guard|typecheck')
  }
}
