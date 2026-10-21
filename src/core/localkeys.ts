// Machine-specific keys: a `# envvault:local` line directly above an
// assignment keeps that key's value on this machine. Pushes upload the file
// with those values blanked (projectEnv), status hashes the same projection,
// and pulls write the vault copy with this machine's lines put back
// (mergePull). Files without markers are left exactly as they are.
import { scanLines, type Scanned } from './envlines'

export const LOCAL_MARKER = '# envvault:local'

/** A machine-specific key appears more than once, so a merge would be ambiguous. */
export class DuplicateLocalKeyError extends Error {
  constructor() {
    super('A machine-specific key appears more than once.')
    this.name = 'DuplicateLocalKeyError'
  }
}

/** Keys marked machine-specific in `text`, sorted. */
export function markedKeys(text: string): string[] {
  return [...scanLines(text).marked].sort()
}

/**
 * Keys the vault copy marks machine-specific that `local` has without a
 * marker: pushing would upload their values. Sorted.
 */
export function unmarkedKeys(local: string, vault: string | null): string[] {
  if (vault === null) return []
  const l = scanLines(local)
  return [...scanLines(vault).marked].filter((k) => l.byKey.has(k) && !l.marked.has(k)).sort()
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
  const s = scanLines(text)
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
 * The machine-specific keys a pull keeps from the local file (marked in
 * either file, and assigned locally), and the keys the vault marks that the
 * local file lacks (written empty).
 */
export function keptKeys(v: Scanned, l: Scanned | null): { keep: Set<string>; unset: string[] } {
  const keep = new Set([...(l?.marked ?? []), ...v.marked].filter((k) => l?.byKey.has(k)))
  const unset = [...v.marked].filter((k) => !l?.byKey.has(k)).sort()
  return { keep, unset }
}

/**
 * Keys whose result comes from the local file in a merge (see mergePull):
 * `local`, present with its local lines or absent if the local file lacks
 * it; `machine`, kept and marked like a machine-specific key.
 */
export type LocalTakes = ReadonlyMap<string, 'local' | 'machine'>

/**
 * What a pull writes: the vault copy, except that every key marked in either
 * file keeps its local lines (verbatim, in the vault's position). A local
 * marker the vault lacks is inserted above its key, and a kept key the vault
 * doesn't have at all is appended, so a pull never overwrites or deletes a
 * machine-specific value. Throws DuplicateLocalKeyError if a kept key appears
 * more than once in either file.
 *
 * Resolving a conflict is the same merge with `takes`: each `local` key
 * gets its local lines in the vault's position, loses its vault lines if the
 * local file lacks it, or is appended if only the local file has it. Each
 * `machine` key the local file has is kept as if it were marked. Keys not in
 * `takes` come from the vault, and a kept key stays kept whatever `takes` says.
 */
export function mergePull(
  vault: string,
  local: string | null,
  takes: LocalTakes = new Map()
): PullMerge {
  const v = scanLines(vault)
  const l = local === null ? null : scanLines(local)
  const { keep, unset } = keptKeys(v, l)
  for (const [k, take] of takes) if (take === 'machine' && l?.byKey.has(k)) keep.add(k)
  const own = new Set([...takes.keys()].filter((k) => !keep.has(k)))
  if (!l || (keep.size === 0 && own.size === 0)) return { text: null, kept: [], unset }
  requireSingle(l, [...keep, ...own])
  requireSingle(v, [...keep, ...own])

  const eol = v.ends.find((e) => e !== '') ?? l.ends.find((e) => e !== '') ?? '\n'
  /** The local lines of `key`'s assignment, the last one ending in `end`. */
  const localLines = (key: string, end: string): string => {
    const a = l.byKey.get(key)?.[0]
    if (!a) return ''
    let text = ''
    for (let k = a.first; k < a.last; k++) text += (l.lines[k] ?? '') + (l.ends[k] ?? '')
    return text + (l.lines[a.last] ?? '') + end
  }

  // Vault keys taken from a local file that lacks them are dropped with their marker.
  const dropped = v.assignments.filter((a) => own.has(a.key) && !l.byKey.has(a.key))
  const droppedMarkers = new Set(
    dropped.filter((a) => v.markerLines.has(a.first - 1)).map((a) => a.first - 1)
  )

  let out = v.bom
  for (let i = 0; i < v.lines.length; i++) {
    const a = v.starts.get(i)
    if (droppedMarkers.has(i)) continue
    if (a && keep.has(a.key)) {
      if (!v.marked.has(a.key)) out += LOCAL_MARKER + eol
      out += localLines(a.key, v.ends[a.last] ?? '')
      i = a.last
    } else if (a && own.has(a.key)) {
      if (l.byKey.has(a.key)) out += localLines(a.key, v.ends[a.last] ?? '')
      i = a.last
    } else {
      out += (v.lines[i] ?? '') + (v.ends[i] ?? '')
    }
  }

  // Local keys the vault lacks are appended in local order. Kept ones are
  // marked locally (the vault can't mark a key it doesn't have).
  const missing = l.assignments.filter(
    (a) => (keep.has(a.key) || own.has(a.key)) && !v.byKey.has(a.key)
  )
  if (missing.length > 0 && out !== v.bom && !out.endsWith('\n')) out += eol
  for (const a of missing) {
    out += (keep.has(a.key) ? LOCAL_MARKER + eol : '') + localLines(a.key, eol)
  }

  return { text: out, kept: [...keep].sort(), unset }
}

/**
 * What resolving writes when this machine's copy wins every key: the local
 * file as written, except that each key made machine-specific (`machine`) or
 * marked in the vault copy gets a marker if it lacks one, and the vault's
 * machine-specific keys the local file lacks are appended empty, as a pull
 * writes them. So nothing the vault keeps per machine is lost, and the rest
 * is byte for byte the local file. Throws DuplicateLocalKeyError if a key to
 * mark is assigned more than once.
 */
export function keepLocal(vault: string, local: string, machine: Iterable<string> = []): string {
  const v = scanLines(vault)
  const l = scanLines(local)
  const { unset } = keptKeys(v, l)
  const mark = new Set([...v.marked, ...machine].filter((k) => l.byKey.has(k) && !l.marked.has(k)))
  requireSingle(l, mark)

  const eol = l.ends.find((e) => e !== '') ?? v.ends.find((e) => e !== '') ?? '\n'
  let out = l.bom
  for (let i = 0; i < l.lines.length; i++) {
    const a = l.starts.get(i)
    if (a && mark.has(a.key)) out += LOCAL_MARKER + eol
    out += (l.lines[i] ?? '') + (l.ends[i] ?? '')
  }
  if (unset.length > 0 && out !== l.bom && !out.endsWith('\n')) out += eol
  for (const key of unset) out += `${LOCAL_MARKER}${eol}${key}=${eol}`
  return out
}

/**
 * `layout` with each of `keys` taken from `other`: `other`'s lines verbatim
 * in the layout's position, dropped (with a marker line above) if `other`
 * lacks the key, or appended in `other`'s order (with `other`'s marker) if
 * only `other` has it. Everything else stays byte for byte. The mirror of
 * mergePull's local takes, for a merge in the local file's layout. Throws
 * DuplicateLocalKeyError if one of `keys` is assigned twice in either file.
 */
export function mergeKeys(layout: string, other: string, keys: Iterable<string>): string {
  const l = scanLines(layout)
  const o = scanLines(other)
  const take = new Set(keys)
  if (take.size === 0) return layout
  requireSingle(l, take)
  requireSingle(o, take)

  const eol = l.ends.find((e) => e !== '') ?? o.ends.find((e) => e !== '') ?? '\n'
  /** `other`'s lines of `key`'s assignment, the last one ending in `end`. */
  const otherLines = (key: string, end: string): string => {
    const a = o.byKey.get(key)?.[0]
    if (!a) return ''
    let text = ''
    for (let k = a.first; k < a.last; k++) text += (o.lines[k] ?? '') + (o.ends[k] ?? '')
    return text + (o.lines[a.last] ?? '') + end
  }
  const dropped = l.assignments.filter((a) => take.has(a.key) && !o.byKey.has(a.key))
  const droppedMarkers = new Set(
    dropped.filter((a) => l.markerLines.has(a.first - 1)).map((a) => a.first - 1)
  )

  let out = l.bom
  for (let i = 0; i < l.lines.length; i++) {
    const a = l.starts.get(i)
    if (droppedMarkers.has(i)) continue
    if (a && take.has(a.key)) {
      out += otherLines(a.key, l.ends[a.last] ?? '')
      i = a.last
    } else {
      out += (l.lines[i] ?? '') + (l.ends[i] ?? '')
    }
  }
  const added = o.assignments.filter((a) => take.has(a.key) && !l.byKey.has(a.key))
  if (added.length > 0 && out !== l.bom && !out.endsWith('\n')) out += eol
  for (const a of added) {
    out += (o.marked.has(a.key) ? LOCAL_MARKER + eol : '') + otherLines(a.key, eol)
  }
  return out
}
