// Resolving a conflict key by key. compareEnv lists the keys whose copies
// differ, so the user can choose one copy per key, and takesFor checks those
// choices before mergePull (core/localkeys) builds the merged file from them.
// Two-way: without the version both copies started from, a key only one copy
// has may have been added there or removed from the other, so every
// difference is the user's choice.
import type { MergeChoice, MergeKey, MergeValues } from '../shared/types'
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
}

/** The choices don't fit the comparison. Messages never contain keys or values. */
export class MergeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MergeError'
  }
}

function requireUnique(s: Scanned): void {
  for (const list of s.byKey.values()) if (list.length > 1) throw new DuplicateKeyError()
}

/**
 * How the local file and the vault copy differ, key by key. Values compare
 * as parseEnv reads them, so quoting and comments alone are not a difference.
 * Throws DuplicateKeyError if a key is assigned twice in either file.
 */
export function compareEnv(local: string, vault: string): EnvComparison {
  const l = scanLines(local)
  const v = scanLines(vault)
  requireUnique(l)
  requireUnique(v)
  const { keep, unset } = keptKeys(v, l)
  const keys: MergeKey[] = []
  let unchanged = 0
  for (const a of l.assignments) {
    if (keep.has(a.key)) continue
    const other = v.byKey.get(a.key)?.[0]
    if (!other) keys.push({ key: a.key, kind: 'local-only' })
    else if (other.value !== a.value) keys.push({ key: a.key, kind: 'differs' })
    else unchanged++
  }
  for (const a of v.assignments) {
    // A vault-marked key the local file lacks is `unset`, written empty.
    if (!l.byKey.has(a.key) && !v.marked.has(a.key)) {
      keys.push({ key: a.key, kind: 'vault-only' })
    }
  }
  return { keys, kept: [...keep].sort(), unset, unchanged }
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
