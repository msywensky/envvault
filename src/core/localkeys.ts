// Machine-specific keys: a `# envvault:local` line directly above an
// assignment keeps that key's value on this machine. Pushes upload the file
// with those values blanked (projectEnv), status hashes the same projection,
// and pulls write the vault copy with this machine's lines put back
// (mergePull). Files without markers are left exactly as they are.
import { scanEnv, type Assignment } from './envdiff'

export const LOCAL_MARKER = '# envvault:local'
const MARKER_RE = /^\s*#\s*envvault:local\s*$/
const BOM = '\uFEFF'

/** A machine-specific key appears more than once, so a merge would be ambiguous. */
export class DuplicateLocalKeyError extends Error {
  constructor() {
    super('A machine-specific key appears more than once.')
    this.name = 'DuplicateLocalKeyError'
  }
}

interface Scanned {
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

function scan(text: string): Scanned {
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

/** Keys marked machine-specific in `text`, sorted. */
export function markedKeys(text: string): string[] {
  return [...scan(text).marked].sort()
}

/**
 * Keys the vault copy marks machine-specific that `local` has without a
 * marker: pushing would upload their values. Sorted.
 */
export function unmarkedKeys(local: string, vault: string | null): string[] {
  if (vault === null) return []
  const l = scan(local)
  return [...scan(vault).marked].filter((k) => l.byKey.has(k) && !l.marked.has(k)).sort()
}

function requireSingle(s: Scanned, keys: Iterable<string>): void {
  for (const k of keys) if ((s.byKey.get(k)?.length ?? 0) > 1) throw new DuplicateLocalKeyError()
}

/**
 * The text a push uploads and status hashes: a marked assignment becomes a
 * bare `KEY=` (no export, spacing, value or comment) and its marker becomes
 * LOCAL_MARKER, so differently formatted files on two machines project the
 * same. Everything else is unchanged. Null if nothing is marked: then use the
 * original bytes. Throws DuplicateLocalKeyError if a marked key is assigned
 * more than once.
 */
export function projectEnv(text: string): string | null {
  const s = scan(text)
  if (s.marked.size === 0) return null
  requireSingle(s, s.marked)
  let out = s.bom
  for (let i = 0; i < s.lines.length; i++) {
    const a = s.starts.get(i)
    if (s.markerLines.has(i)) {
      out += LOCAL_MARKER + (s.ends[i] ?? '')
    } else if (a && s.marked.has(a.key)) {
      out += `${a.key}=` + (s.ends[a.last] ?? '')
      i = a.last
    } else {
      out += (s.lines[i] ?? '') + (s.ends[i] ?? '')
    }
  }
  return out
}

export interface PullMerge {
  /** The text a pull writes, or null to write the vault copy unchanged. */
  text: string | null
  /** Machine-specific keys whose local lines are kept. Sorted. */
  kept: string[]
  /** Keys the vault marks machine-specific that the local file lacks: written empty. Sorted. */
  unset: string[]
}

/**
 * What a pull writes: the vault copy, except that every key marked in either
 * file keeps its local lines (verbatim, in the vault's position). A local
 * marker the vault lacks is inserted above its key, and a kept key the vault
 * doesn't have at all is appended, so a pull never overwrites or deletes a
 * machine-specific value. Throws DuplicateLocalKeyError if a kept key appears
 * more than once in either file.
 */
export function mergePull(vault: string, local: string | null): PullMerge {
  const v = scan(vault)
  const l = local === null ? null : scan(local)
  const keep = new Set([...(l?.marked ?? []), ...v.marked].filter((k) => l?.byKey.has(k)))
  const unset = [...v.marked].filter((k) => !l?.byKey.has(k)).sort()
  if (!l || keep.size === 0) return { text: null, kept: [], unset }
  requireSingle(l, keep)
  requireSingle(v, keep)

  const eol = v.ends.find((e) => e !== '') ?? l.ends.find((e) => e !== '') ?? '\n'
  /** The local lines of `key`'s assignment, the last one ending in `end`. */
  const localLines = (key: string, end: string): string => {
    const a = l.byKey.get(key)?.[0]
    if (!a) return ''
    let text = ''
    for (let k = a.first; k < a.last; k++) text += (l.lines[k] ?? '') + (l.ends[k] ?? '')
    return text + (l.lines[a.last] ?? '') + end
  }

  let out = v.bom
  for (let i = 0; i < v.lines.length; i++) {
    const a = v.starts.get(i)
    if (a && keep.has(a.key)) {
      if (!v.marked.has(a.key)) out += LOCAL_MARKER + eol
      out += localLines(a.key, v.ends[a.last] ?? '')
      i = a.last
    } else {
      out += (v.lines[i] ?? '') + (v.ends[i] ?? '')
    }
  }

  // Kept keys the vault lacks are marked locally (the vault can't mark a key
  // it doesn't have). Append them in local order.
  const missing = l.assignments.filter((a) => keep.has(a.key) && !v.byKey.has(a.key))
  if (missing.length > 0 && out !== v.bom && !out.endsWith('\n')) out += eol
  for (const a of missing) out += LOCAL_MARKER + eol + localLines(a.key, eol)

  return { text: out, kept: [...keep].sort(), unset }
}
