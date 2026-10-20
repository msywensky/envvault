// Editing a .env as a key/value table (the in-app editor for the vault copy).
// decodeValue and encodeValue follow dotenv's parser (16.x), so the table
// shows, and saving writes, what an app using dotenv reads. applyEdits splices
// changes into the original text and leaves every untouched line as it was.
import type { EditorEntry, SaveEditRequest } from '../shared/types'
import { KEY_RE, type Assignment } from './envdiff'
import { scanLines, type Scanned } from './envlines'
import { LOCAL_MARKER } from './localkeys'

/** A key is assigned more than once, so a table row would be ambiguous. */
export class DuplicateKeyError extends Error {
  constructor() {
    super('A key is assigned more than once.')
    this.name = 'DuplicateKeyError'
  }
}

/** The edits don't fit the text. Messages never contain keys or values. */
export class EditError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EditError'
  }
}

export type Edits = Pick<SaveEditRequest, 'set' | 'add' | 'remove' | 'mark'>

/**
 * The value dotenv reads for `a`: quotes are stripped, `\n` and `\r` are
 * expanded inside double quotes only, and an unquoted value ends at the first
 * `#`, even without a space before it.
 */
export function decodeValue(a: Assignment): string {
  if (a.quote === '"') return a.value.replace(/\\n/g, '\n').replace(/\\r/g, '\r')
  if (a.quote) return a.value
  const hash = a.value.indexOf('#')
  return (hash === -1 ? a.value : a.value.slice(0, hash)).trim()
}

/**
 * `value` written so that dotenv reads it back exactly: bare if possible,
 * else in the first quotes that can hold it. Line breaks inside single or
 * backtick quotes are written as `eol`; dotenv turns CRLF back into LF.
 * Throws EditError if no form fits (every quote kind, or a CR plus a double
 * quote, or a trailing backslash inside quotes).
 */
export function encodeValue(value: string, eol = '\n'): string {
  if (value === '') return ''
  const bare = !/[#\r\n]/.test(value) && value.trim() === value && !/^['"`]/.test(value)
  if (bare) return value
  // A trailing backslash would escape the closing quote.
  if (!value.endsWith('\\')) {
    // dotenv turns any CR in the file into LF, so only double quotes keep one.
    if (!value.includes("'") && !value.includes('\r')) return `'${value.replace(/\n/g, eol)}'`
    if (!value.includes('"') && !/\\[nr]/.test(value)) {
      return `"${value.replace(/\n/g, '\\n').replace(/\r/g, '\\r')}"`
    }
    if (!value.includes('`') && !value.includes('\r')) return `\`${value.replace(/\n/g, eol)}\``
  }
  throw new EditError("A value can't be written to a .env file. Change it and try again.")
}

function requireUnique(s: Scanned): void {
  for (const list of s.byKey.values()) if (list.length > 1) throw new DuplicateKeyError()
}

/**
 * The table rows for `text`, in file order. Machine-specific keys get an
 * empty value: the vault copy holds none. Throws DuplicateKeyError if a key
 * is assigned twice.
 */
export function editorEntries(text: string): EditorEntry[] {
  const s = scanLines(text)
  requireUnique(s)
  return s.assignments.map((a) => {
    const marked = s.marked.has(a.key)
    return { key: a.key, value: marked ? '' : decodeValue(a), marked }
  })
}

/**
 * `text` with the edits applied, everything else unchanged: a changed value
 * keeps its line's prefix (indent, `export`, spacing) and trailing comment,
 * a removed key loses its marker line too, a marked key gets LOCAL_MARKER
 * directly above it (its value stays: projectEnv blanks it), and added keys
 * are appended. Throws EditError if the edits don't fit the text, and
 * DuplicateKeyError if a key is assigned twice.
 */
export function applyEdits(text: string, edits: Edits): string {
  const s = scanLines(text)
  requireUnique(s)
  const keys = [
    ...edits.set.map((c) => c.key),
    ...edits.add.map((c) => c.key),
    ...edits.remove,
    ...edits.mark
  ]
  if (new Set(keys).size !== keys.length) throw new EditError('A key was edited more than once.')
  const gone = (): EditError => new EditError('A key you edited is no longer in the vault copy.')
  for (const { key } of edits.set) {
    if (!s.byKey.has(key)) throw gone()
    if (s.marked.has(key)) {
      throw new EditError('Machine-specific values are set on each machine, not in the vault.')
    }
  }
  for (const key of edits.remove) if (!s.byKey.has(key)) throw gone()
  for (const key of edits.mark) {
    if (!s.byKey.has(key)) throw gone()
    if (s.marked.has(key)) throw new EditError('A key you marked is already machine-specific.')
  }
  for (const { key } of edits.add) {
    if (!KEY_RE.test(key)) throw new EditError('A key name is not valid.')
    if (s.byKey.has(key)) throw new EditError('A key you added is already in the vault copy.')
  }

  const eol = s.ends.find((e) => e !== '') ?? '\n'
  const set = new Map(edits.set.map((c) => [c.key, c.value]))
  const remove = new Set(edits.remove)
  const mark = new Set(edits.mark)
  const markersToDrop = new Set(
    s.assignments
      .filter((a) => remove.has(a.key) && s.markerLines.has(a.first - 1))
      .map((a) => a.first - 1)
  )

  let out = s.bom
  for (let i = 0; i < s.lines.length; i++) {
    const a = s.starts.get(i)
    if (markersToDrop.has(i)) continue
    if (a && remove.has(a.key)) {
      i = a.last
      continue
    }
    if (a && mark.has(a.key)) out += LOCAL_MARKER + eol
    const value = a ? set.get(a.key) : undefined
    if (a && value !== undefined) {
      const line = s.lines[i] ?? ''
      const eq = line.indexOf('=')
      const encoded = encodeValue(value, eol)
      // Keep the spacing after `=` when there is a value to put after it.
      const gap = encoded === '' ? '' : (/^\s*/.exec(line.slice(eq + 1))?.[0] ?? '')
      const tail = a.comment === null ? '' : ` ${a.comment}`
      out += line.slice(0, eq + 1) + gap + encoded + tail + (s.ends[a.last] ?? '')
      i = a.last
      continue
    }
    out += (s.lines[i] ?? '') + (s.ends[i] ?? '')
  }

  if (edits.add.length > 0 && out !== s.bom && !out.endsWith('\n')) out += eol
  for (const { key, value } of edits.add) out += `${key}=${encodeValue(value, eol)}${eol}`
  return out
}
