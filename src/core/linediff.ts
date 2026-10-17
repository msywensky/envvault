import type { RawDiffLine } from '../shared/types'
import { maskEnvLines } from './envdiff'

type TextLine = Exclude<RawDiffLine, { kind: 'gap' }>

/** Above this many LCS cells, a changed block is shown as a plain replacement. */
export const MAX_DIFF_CELLS = 4_000_000

// Control, format (zero-width, bidi, BOM) and line/paragraph separators:
// invisible, or able to reorder what is displayed. Tab is left as is.
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu

/** Show invisible characters as `\u{XXXX}` so every difference can be seen. */
function visible(text: string): string {
  return text.replace(INVISIBLE, (c) =>
    c === '\t' ? c : `\\u{${(c.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}}`
  )
}

/** Lines without their endings, so CRLF vs LF and a final newline don't count. */
function splitLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split(/\r?\n/)
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** Shortest edit script from `a` to `b`, deletions before additions. */
function editScript(a: string[], b: string[]): TextLine[] {
  const out: TextLine[] = []
  const same = (i: number, j: number): void => {
    out.push({ kind: 'same', text: a[i] ?? '', oldNo: i + 1, newNo: j + 1 })
  }
  const del = (i: number): void => {
    out.push({ kind: 'del', text: a[i] ?? '', oldNo: i + 1, newNo: null })
  }
  const add = (j: number): void => {
    out.push({ kind: 'add', text: b[j] ?? '', oldNo: null, newNo: j + 1 })
  }

  // Only the middle part between the common prefix and suffix needs the LCS.
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  for (let k = 0; k < start; k++) same(k, k)

  const n = endA - start
  const m = endB - start
  if (n * m > MAX_DIFF_CELLS) {
    for (let i = start; i < endA; i++) del(i)
    for (let j = start; j < endB; j++) add(j)
  } else {
    // lcs[i * w + j]: LCS length of a[start+i..endA) and b[start+j..endB).
    // At most min(n, m) <= 2000 given the cell limit, so 16 bits suffice.
    const w = m + 1
    const lcs = new Uint16Array((n + 1) * w)
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * w + j] =
          a[start + i] === b[start + j]
            ? (lcs[(i + 1) * w + j + 1] ?? 0) + 1
            : Math.max(lcs[(i + 1) * w + j] ?? 0, lcs[i * w + j + 1] ?? 0)
      }
    }
    let i = 0
    let j = 0
    while (i < n || j < m) {
      if (i < n && j < m && a[start + i] === b[start + j]) {
        same(start + i++, start + j++)
      } else if (j === m || (i < n && (lcs[(i + 1) * w + j] ?? 0) >= (lcs[i * w + j + 1] ?? 0))) {
        del(start + i++)
      } else {
        add(start + j++)
      }
    }
  }

  for (let k = 0; k < a.length - endA; k++) same(endA + k, endB + k)
  return out
}

export interface LineDiffOptions {
  /** Unchanged lines shown around each change. */
  context?: number
  /** Show each line with its values masked (see maskEnvLines). */
  mask?: boolean
}

/**
 * Line-by-line diff from `oldText` to `newText`: changed lines plus `context`
 * unchanged lines around them, other unchanged runs as a `gap` count.
 * Returns [] when no line changes. The lines are always compared in full;
 * unless `mask` is set, the result contains them, so it carries env values
 * (see sync.pullRawDiff).
 */
export function lineDiff(
  oldText: string,
  newText: string,
  { context = 3, mask = false }: LineDiffOptions = {}
): RawDiffLine[] {
  const a = splitLines(oldText)
  const b = splitLines(newText)
  const script = editScript(a, b)
  const shownA = mask ? maskEnvLines(a) : a
  const shownB = mask ? maskEnvLines(b) : b
  const keep = new Uint8Array(script.length)
  let changed = false
  script.forEach((line, i) => {
    if (line.kind === 'same') return
    changed = true
    const to = Math.min(script.length - 1, i + context)
    for (let k = Math.max(0, i - context); k <= to; k++) keep[k] = 1
  })
  if (!changed) return []

  const out: RawDiffLine[] = []
  let gap = 0
  script.forEach((line, i) => {
    if (!keep[i]) {
      gap++
      return
    }
    if (gap) out.push({ kind: 'gap', count: gap })
    gap = 0
    const text = line.oldNo !== null ? shownA[line.oldNo - 1] : shownB[(line.newNo ?? 0) - 1]
    out.push({ ...line, text: visible(text ?? '') })
  })
  if (gap) out.push({ kind: 'gap', count: gap })
  return out
}
