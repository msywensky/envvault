import type { DiffResult } from '../shared/types'

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/
const QUOTES = new Set(['"', "'", '`'])

/** Index of the first unescaped `quote` in `s` at or after `from`, or -1. */
function closingQuote(s: string, quote: string, from: number): number {
  for (let i = from; i < s.length; i++) {
    if (s[i] === '\\') i++
    else if (s[i] === quote) return i
  }
  return -1
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
  const lines = text.split(/\r?\n/)
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
    if (quote !== undefined && QUOTES.has(quote)) {
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
        out.set(key, body.slice(0, end))
        i = j
        continue
      }
      // Unterminated: fall through and treat this line as unquoted.
    }

    const comment = rest.startsWith('#') ? 0 : rest.search(/\s#/)
    out.set(key, (comment === -1 ? rest : rest.slice(0, comment)).trim())
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
