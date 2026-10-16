// Per-machine record of what was last pushed/pulled for each repo, kept
// separately for each vault (by vaultId), so switching vaults and back
// loses nothing and never reuses another vault's state.
import { app } from 'electron'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { LastSync } from '../shared/types'
import { atomicWrite, isErrno } from './fsutil'
import { createSerial } from './mutex'
import { Hash } from './schemas'

const FILE = 'state.json'

const Repos = z.record(z.string(), z.object({ version: z.int().min(1), contentHash: Hash }))
const StateSchema = z.object({ vaults: z.record(z.string(), Repos) })

type State = z.infer<typeof StateSchema>

let cache: State | null = null
// Writes are read-modify-write on the cache, so they must not interleave.
const serial = createSerial()

async function load(): Promise<State> {
  if (cache) return cache
  let state: State = { vaults: {} }
  try {
    const parsed = StateSchema.safeParse(
      JSON.parse(await readFile(join(app.getPath('userData'), FILE), 'utf8'))
    )
    if (parsed.success) state = parsed.data
  } catch (err) {
    if (!isErrno(err, 'ENOENT')) console.error('[envvault] state.json unreadable; starting fresh')
  }
  cache = state
  return state
}

// Own properties only: a repo named "constructor" must not read Object.prototype.
const own = <T>(obj: Record<string, T>, key: string): T | null =>
  Object.hasOwn(obj, key) ? (obj[key] ?? null) : null

export async function getLast(vaultId: string, repoId: string): Promise<LastSync | null> {
  const repos = own((await load()).vaults, vaultId)
  return repos ? own(repos, repoId) : null
}

export function setLast(vaultId: string, repoId: string, last: LastSync): Promise<void> {
  return serial(async () => {
    const state = await load()
    const repos = { ...own(state.vaults, vaultId), [repoId]: last }
    const next: State = { vaults: { ...state.vaults, [vaultId]: repos } }
    const dir = app.getPath('userData')
    await mkdir(dir, { recursive: true })
    await atomicWrite(dir, FILE, JSON.stringify(next, null, 2))
    cache = next
  })
}
