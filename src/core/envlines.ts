// A line-level view of a .env file for code that rewrites it: each line with
// its own ending, assignments by position and by key, and the
// `# envvault:local` markers. Writers copy untouched lines verbatim, so CRLF,
// a missing final newline and a byte order mark survive.
import { scanEnv, type Assignment } from './envdiff'

const MARKER_RE = /^\s*#\s*envvault:local\s*$/
const BOM = '\uFEFF'

export interface Scanned {
  /** A leading byte order mark, kept out of `lines` and added back on output. */
  bom: string
  /** Lines without their endings. */
  lines: string[]
  /** Each line's ending: '\n', '\r\n', or '' for a last line without one. */
  ends: string[]
  assignments: Assignment[]
  /** Assignments by the line they start on. */
  starts: Map<number, Assignment>
  /** Assignments by key, in file order. */
  byKey: Map<string, Assignment[]>
  /** Keys with at least one marked assignment. */
  marked: Set<string>
  /** Marker lines that apply to an assignment. */
  markerLines: Set<number>
}

export function scanLines(text: string): Scanned {
  const bom = text.startsWith(BOM) ? BOM : ''
  const body = text.slice(bom.length)
  const parts = body === '' ? [] : body.split(/(?<=\n)/)
  const lines = parts.map((p) => p.replace(/\r?\n$/, ''))
  const ends = parts.map((p, i) => p.slice((lines[i] ?? '').length))
  const assignments = scanEnv(lines)

  const starts = new Map<number, Assignment>()
  const byKey = new Map<string, Assignment[]>()
  const covered = new Set<number>()
  for (const a of assignments) {
    starts.set(a.first, a)
    byKey.set(a.key, [...(byKey.get(a.key) ?? []), a])
    for (let k = a.first; k <= a.last; k++) covered.add(k)
  }
  const marked = new Set<string>()
  const markerLines = new Set<number>()
  for (const a of assignments) {
    const m = a.first - 1
    // A line inside a multi-line value is part of that value, not a marker.
    if (m >= 0 && !covered.has(m) && MARKER_RE.test(lines[m] ?? '')) {
      marked.add(a.key)
      markerLines.add(m)
    }
  }
  return { bom, lines, ends, assignments, starts, byKey, marked, markerLines }
}
