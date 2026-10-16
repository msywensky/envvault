import { app } from 'electron'
import { mkdir, readFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import type { Settings } from '../shared/types'
import { atomicWrite, isErrno } from './fsutil'
import { createSerial } from './mutex'
import { AutoLockMinutes, MachineName } from './schemas'

const FILE = 'config.json'
// Updates are read-modify-write on the cache, so they must not interleave.
const serial = createSerial()

const ConfigSchema = z.strictObject({
  projectsPath: z.string().min(1).nullable(),
  vaultPath: z.string().min(1).nullable(),
  autoLockMinutes: AutoLockMinutes,
  machineName: MachineName
})

// Loading is forgiving: a bad or missing field falls back to its default.
const LoadSchema = z.object({
  projectsPath: ConfigSchema.shape.projectsPath.catch(null),
  vaultPath: ConfigSchema.shape.vaultPath.catch(null),
  autoLockMinutes: AutoLockMinutes.catch(5),
  machineName: MachineName.catch(() => defaultMachineName())
})

function defaultMachineName(): string {
  const parsed = MachineName.safeParse(hostname())
  return parsed.success ? parsed.data : 'this-computer'
}

let cache: Settings | null = null

/** Load config.json (cached). */
export async function getConfig(): Promise<Settings> {
  if (cache) return cache
  let raw: unknown = {}
  try {
    raw = JSON.parse(await readFile(join(app.getPath('userData'), FILE), 'utf8'))
  } catch (err) {
    if (!isErrno(err, 'ENOENT')) console.error('[envvault] config.json unreadable; using defaults')
  }
  cache = LoadSchema.parse(typeof raw === 'object' && raw !== null ? raw : {})
  return cache
}

/** Validate strictly and persist. */
export function updateConfig(patch: Partial<Settings>): Promise<Settings> {
  return serial(async () => {
    const next = ConfigSchema.parse({ ...(await getConfig()), ...patch })
    const dir = app.getPath('userData')
    await mkdir(dir, { recursive: true })
    await atomicWrite(dir, FILE, JSON.stringify(next, null, 2))
    cache = next
    return next
  })
}
