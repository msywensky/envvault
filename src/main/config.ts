import { app } from 'electron'
import { mkdir, readFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import type { Settings } from '../shared/types'
import { atomicWrite, isErrno } from './fsutil'
import { createSerial } from './mutex'
import { AutoLockMinutes, MachineName, VaultLocation } from './schemas'

const FILE = 'config.json'
// Updates are read-modify-write on the cache, so they must not interleave.
const serial = createSerial()

const ConfigSchema = z.strictObject({
  projectsPath: z.string().min(1).nullable(),
  vault: VaultLocation.nullable(),
  autoLockMinutes: AutoLockMinutes,
  machineName: MachineName,
  checkExample: z.boolean(),
  autoPull: z.boolean(),
  cliAccess: z.boolean()
})

// Loading is forgiving: a bad or missing field falls back to its default.
const LoadSchema = z.object({
  projectsPath: ConfigSchema.shape.projectsPath.catch(null),
  vault: ConfigSchema.shape.vault.catch(null),
  autoLockMinutes: AutoLockMinutes.catch(5),
  machineName: MachineName.catch(() => defaultMachineName()),
  checkExample: z.boolean().catch(true),
  autoPull: z.boolean().catch(true),
  cliAccess: z.boolean().catch(false)
})

/**
 * Before vault kinds, the vault was always a folder, saved as `vaultPath`.
 * Only the new shape is saved; an older EnvVault reading it shows Setup again.
 */
function migrate(raw: object): object {
  if ('vault' in raw || !('vaultPath' in raw)) return raw
  const { vaultPath, ...rest } = raw as { vaultPath: unknown }
  return typeof vaultPath === 'string'
    ? { ...rest, vault: { kind: 'folder', path: vaultPath } }
    : rest
}

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
  cache = LoadSchema.parse(typeof raw === 'object' && raw !== null ? migrate(raw) : {})
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
