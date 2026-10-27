import type { DiffResult } from '../shared/types'

/** A key name EnvVault recognises. */
export const KEY_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/

export type Quote = '"' | "'" | '`'
const QUOTES = new Set<string>(['"', "'", '`'])
const isQuote = (c: string | undefined): c is Quote => c !== undefined && QUOTES.has(c)

/** Index of the first unescaped `quote` in `s` at or after `from`, or -1. */
function closingQuote(s: string, quote: string, from: number): number {
  for (let i = from; i < s.length; i++) {
    if (s[i] === '\\') i++
    else if (s[i] === quote) return i
  }
  return -1
}

/** One KEY=value assignment on lines `first`..`last` (several for a multi-line quoted value). */
export interface Assignment {
  key: string
  value: string
  first: number
  last: number
  /** A `# comment` after the value on its last line, if any. */
  comment: string | null
  /** The quote around the value, or null if it is unquoted. */
  quote: Quote | null
}

/** The assignments in `lines`, in order. See parseEnv for the rules. */
export function scanEnv(lines: string[]): Assignment[] {
  const out: Assignment[] = []
  for (let i = 0; i < lines.length; i++) {
    let line = (lines[i] ?? '').trimStart()
    if (line === '' || line.startsWith('#')) continue
    line = line.replace(/^export\s+/, '')
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    if (!KEY_RE.test(key)) continue
    const rest = line.slice(eq + 1).trimStart()

    const quote = rest[0]
    if (isQuote(quote)) {
      // Look for the closing quote on this line, then on following lines.
      let body = rest.slice(1)
      let end = closingQuote(body, quote, 0)
      let j = i
      while (end === -1 && j + 1 < lines.length) {
        j++
        const from = body.length + 1
        body += '\n' + (lines[j] ?? '')
        end = closingQuote(body, quote, from)
      }
      if (end !== -1) {
        const after = body.slice(end + 1).trimStart()
        const comment = after.startsWith('#') ? after : null
        out.push({ key, value: body.slice(0, end), first: i, last: j, comment, quote })
        i = j
        continue
      }
      // Unterminated: fall through and treat this line as unquoted.
    }

    const hash = rest.startsWith('#') ? 0 : rest.search(/\s#/)
    out.push({
      key,
      value: (hash === -1 ? rest : rest.slice(0, hash)).trim(),
      first: i,
      last: i,
      comment: hash === -1 ? null : rest.slice(hash).trimStart(),
      quote: null
    })
  }
  return out
}

/**
 * Parse .env text into key -> raw value. Only used to compare values, never
 * to return them. Handles blank lines, # comments, `export KEY=...`,
 * quoted values with backslash escapes (including multi-line ones such as
 * PEM keys) and trailing ` # comments` on unquoted values. A quote with no
 * closing quote anywhere later is treated as part of an unquoted value, as
 * dotenv does. Lines that don't look like KEY=VALUE are ignored, and a later
 * duplicate key wins.
 */
export function parseEnv(text: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const { key, value } of scanEnv(text.split(/\r?\n/))) out.set(key, value)
  return out
}

/**
 * True if every line of `text` is blank, a comment or part of an assignment:
 * how EnvVault tells that a file picked by hand, with a name other than
 * .env*, is in .env format (a JSON or YAML file isn't).
 */
export function isDotenvText(text: string): boolean {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)
  const covered = new Set<number>()
  for (const { first, last } of scanEnv(lines)) {
    for (let k = first; k <= last; k++) covered.add(k)
  }
  return lines.every((line, i) => {
    const trimmed = line.trim()
    return covered.has(i) || trimmed === '' || trimmed.startsWith('#')
  })
}

export const MASK = '••••••••'

/**
 * `lines` with every value replaced by MASK. Keys, comments (whole-line and
 * after a value) and blank lines are kept, and so is an assignment with an
 * empty value. The continuation lines of a multi-line value are masked whole,
 * and so is anything that isn't an assignment, comment or blank line.
 */
export function maskEnvLines(lines: string[]): string[] {
  const out = lines.map((line) => {
    const trimmed = line.trimStart()
    return trimmed === '' || trimmed.startsWith('#') ? line : MASK
  })
  for (const { value, first, last, comment } of scanEnv(lines)) {
    if (value === '') {
      out[first] = lines[first] ?? ''
      continue
    }
    const line = lines[first] ?? ''
    const tail = comment === null ? '' : ` ${comment}`
    // Everything before the first '=' is indentation, `export` and the key.
    out[first] = line.slice(0, line.indexOf('=') + 1) + MASK + (first === last ? tail : '')
    for (let k = first + 1; k <= last; k++) out[k] = MASK + (k === last ? tail : '')
  }
  return out
}

/**
 * Key names that change when `source` replaces `target`: for a push the
 * source is local and the target is the vault; for a pull, the reverse.
 * Returns names only, sorted.
 */
export function diffKeys(source: Map<string, string>, target: Map<string, string>): DiffResult {
  const added: string[] = []
  const removed: string[] = []
  const changed: string[] = []
  let unchanged = 0
  for (const [key, value] of source) {
    if (!target.has(key)) added.push(key)
    else if (target.get(key) !== value) changed.push(key)
    else unchanged++
  }
  for (const key of target.keys()) {
    if (!source.has(key)) removed.push(key)
  }
  return { added: added.sort(), removed: removed.sort(), changed: changed.sort(), unchanged }
}
