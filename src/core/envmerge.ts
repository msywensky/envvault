// Resolving a conflict key by key. compareEnv lists the keys whose copies
// differ, so the user can choose one copy per key, and takesFor checks those
// choices before mergePull or keepLocal (core/localkeys) build the merged file
// from them. With the base, what this machine last synced, it is three-way:
// a key that changed on one side only has a suggested copy, and only keys
// changed on both are the user's to decide. Without one, a key only one copy
// has may have been added there or removed from the other, so every
// difference is the user's choice.
import type { KeyChange, MergeChoice, MergeKey, MergeTake, MergeValues } from '../shared/types'
import { DuplicateKeyError, decodeValue } from './envedit'
import { scanLines, type Scanned } from './envlines'
import { keptKeys, type LocalTakes } from './localkeys'

export interface EnvComparison {
  /** Keys that need a choice: local file order, then vault-only keys in vault order. */
  keys: MergeKey[]
  /** Machine-specific keys kept from the local file, as on a pull. Sorted. */
  kept: string[]
  /** Keys the vault marks machine-specific that the local file lacks. Sorted. */
  unset: string[]
  /** Keys with the same value in both copies. */
  unchanged: number
  /** A base was given and could be used. */
  hasBase: boolean
  /** Comments and blank lines changed since the base, per side; null without a base. */
  layoutChanged: { local: boolean; vault: boolean } | null
  /** Every key has a suggestion, and the layout changed on at most one side. */
  clean: boolean
}

/** The choices don't fit the comparison. Messages never contain keys or values. */
export class MergeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MergeError'
  }
}

const isUnique = (s: Scanned): boolean => [...s.byKey.values()].every((list) => list.length === 1)

function requireUnique(s: Scanned): void {
  if (!isUnique(s)) throw new DuplicateKeyError()
}

/** What happened to `key` on one side (`now`) since the base. */
function changeOf(base: Scanned, now: Scanned, key: string): KeyChange {
  const was = base.byKey.get(key)?.[0]
  const is = now.byKey.get(key)?.[0]
  if (!was) return is ? 'added' : 'same'
  if (!is) return 'removed'
  return was.value === is.value ? 'same' : 'changed'
}

/** The copy to take when only one side changed the key. */
function suggestionOf(here: KeyChange | null, there: KeyChange | null): MergeTake | null {
  if (here === null || there === null) return null
  if (here === 'same') return 'vault'
  if (there === 'same') return 'local'
  return null
}

/** Comments, blank lines and anything else that isn't an assignment or a marker, in order. */
function layoutOf(s: Scanned): string {
  const covered = new Set<number>(s.markerLines)
  for (const a of s.assignments) for (let k = a.first; k <= a.last; k++) covered.add(k)
  return s.lines.filter((_, i) => !covered.has(i)).join('\n')
}

/**
 * How the local file and the vault copy differ, key by key. Values compare
 * as parseEnv reads them, so quoting and comments alone are not a difference.
 * With `base` (this machine's last sync), each key also says what changed on
 * each side and which copy to suggest; a base with a key assigned twice is
 * not used. Throws DuplicateKeyError if a key is assigned twice in either file.
 */
export function compareEnv(
  local: string,
  vault: string,
  base: string | null = null
): EnvComparison {
  const l = scanLines(local)
  const v = scanLines(vault)
  requireUnique(l)
  requireUnique(v)
  const scannedBase = base === null ? null : scanLines(base)
  const b = scannedBase && isUnique(scannedBase) ? scannedBase : null
  const { keep, unset } = keptKeys(v, l)
  const keys: MergeKey[] = []
  const listKey = (key: string, kind: MergeKey['kind']): void => {
    const here = b && changeOf(b, l, key)
    const there = b && changeOf(b, v, key)
    keys.push({ key, kind, here, there, suggested: suggestionOf(here, there) })
  }
  let unchanged = 0
  for (const a of l.assignments) {
    if (keep.has(a.key)) continue
    const other = v.byKey.get(a.key)?.[0]
    if (!other) listKey(a.key, 'local-only')
    else if (other.value !== a.value) listKey(a.key, 'differs')
    else unchanged++
  }
  for (const a of v.assignments) {
    // A vault-marked key the local file lacks is `unset`, written empty.
    if (!l.byKey.has(a.key) && !v.marked.has(a.key)) listKey(a.key, 'vault-only')
  }
  const layoutChanged = b && {
    local: layoutOf(l) !== layoutOf(b),
    vault: layoutOf(v) !== layoutOf(b)
  }
  const clean =
    layoutChanged !== null &&
    !(layoutChanged.local && layoutChanged.vault) &&
    keys.every((k) => k.suggested !== null)
  return {
    keys,
    kept: [...keep].sort(),
    unset,
    unchanged,
    hasBase: b !== null,
    layoutChanged,
    clean
  }
}

/**
 * Both copies' values of each key in compareEnv's `keys`, in that order, as
 * dotenv reads them (null: that copy lacks the key).
 */
export function differingValues(local: string, vault: string): MergeValues['values'] {
  const l = scanLines(local)
  const v = scanLines(vault)
  const value = (s: Scanned, key: string): string | null => {
    const a = s.byKey.get(key)?.[0]
    return a ? decodeValue(a) : null
  }
  return compareEnv(local, vault).keys.map(({ key }) => ({
    key,
    local: value(l, key),
    vault: value(v, key)
  }))
}

/**
 * Whether this machine's copy wins every key that differs (`local` or
 * `machine`), so the merged file can be the local file as written (see
 * keepLocal) rather than rebuilt in the vault copy's layout.
 */
export function winsEveryKey(cmp: EnvComparison, takes: LocalTakes): boolean {
  return cmp.keys.length > 0 && cmp.keys.every((k) => takes.has(k.key))
}

/**
 * Pull and mark: `keys` kept from the local file as machine-specific, for
 * mergePull; every other key comes from the vault, as on a pull. Throws
 * MergeError unless each is a key whose values differ, named once.
 */
export function markTakes(cmp: EnvComparison, keys: string[]): LocalTakes {
  const differs = new Set(cmp.keys.filter((k) => k.kind === 'differs').map((k) => k.key))
  const takes = new Map<string, 'machine'>()
  for (const key of keys) {
    if (!differs.has(key)) {
      throw new MergeError('Only a key whose value changes can be marked here. Review again.')
    }
    if (takes.has(key)) throw new MergeError('A key was marked more than once.')
    takes.set(key, 'machine')
  }
  return takes
}

/**
 * The keys taken from the local file, for mergePull. Throws MergeError
 * unless `choices` names every key in `cmp` exactly once, and nothing else,
 * and marks only keys the local file has.
 */
export function takesFor(cmp: EnvComparison, choices: MergeChoice[]): LocalTakes {
  const kinds = new Map(cmp.keys.map((k) => [k.key, k.kind]))
  const takes = new Map<string, 'local' | 'machine'>()
  const seen = new Set<string>()
  for (const { key, take } of choices) {
    const kind = kinds.get(key)
    if (!kind) {
      throw new MergeError('The copies no longer differ the way you reviewed. Review again.')
    }
    if (seen.has(key)) throw new MergeError('A key was chosen more than once.')
    if (take === 'machine' && kind === 'vault-only') {
      throw new MergeError('Only a key this machine has can be made machine-specific.')
    }
    seen.add(key)
    if (take !== 'vault') takes.set(key, take)
  }
  if (seen.size !== kinds.size) throw new MergeError('Choose a copy for every key that differs.')
  return takes
}
