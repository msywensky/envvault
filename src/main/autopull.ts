// Automatic pull: while unlocked and the autoPull setting is on, pull every
// env file whose change is one-sided (sync.autoPull decides). It takes the key
// through session.withKey, which doesn't count as activity, so it never keeps
// the vault unlocked. For the same reason the renderer must not call IPC when
// it hears about a pull: the event carries the updated rows instead.
import type { RepoRow } from '../shared/types'
import { getConfig } from './config'
import { AppError } from './errors'
import { exclusive } from './mutex'
import * as session from './session'
import { autoPull, listRepos } from './sync'

const INTERVAL_MS = 60_000

let running = false
let rerun = false
let report: ((rows: RepoRow[]) => void) | null = null

/**
 * One pass: the rows it pulled. Empty when locked, when the setting is off,
 * or when a pass is already running. Failures are left for the next pass.
 */
export async function runAutoPull(): Promise<RepoRow[]> {
  if (running || !session.isUnlocked()) return []
  running = true
  const pulled: RepoRow[] = []
  try {
    if (!(await getConfig()).autoPull) return []
    // Without asking git: only files the vault has a copy of can be newer there.
    const rows = await session.withKey((key, id) => listRepos(key, id))
    for (const { name, path } of rows.filter((r) => r.status === 'vault-newer')) {
      if (path === null) continue
      const file = { repoName: name, path }
      try {
        // One file per exclusive(): a user's push or pull waits at most for
        // one file, and autoPull re-checks a candidate that went stale.
        const row = await exclusive(() => session.withKey((key, id) => autoPull(key, id, file)))
        if (row) pulled.push(row)
      } catch (err) {
        if (err instanceof AppError && err.code === 'LOCKED') break
      }
    }
  } catch {
    // Not configured, projects folder missing or locked: try the next pass.
  } finally {
    running = false
  }
  return pulled
}

/** Run a pass now, or right after the one in progress. */
export function kickAutoPull(): void {
  if (running) {
    rerun = true
    return
  }
  void (async () => {
    do {
      rerun = false
      const rows = await runAutoPull()
      if (rows.length > 0) report?.(rows)
    } while (rerun)
  })()
}

/** Run a pass every minute, reporting what it pulled to `onPulled`. Call once. */
export function startAutoPull(onPulled: (rows: RepoRow[]) => void): void {
  report = onPulled
  setInterval(kickAutoPull, INTERVAL_MS).unref()
}
