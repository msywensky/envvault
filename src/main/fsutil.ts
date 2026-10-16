import { randomBytes } from 'node:crypto'
import { open, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'

export const randomHex = (bytes: number): string => randomBytes(bytes).toString('hex')

/** Default temp-file name for atomicWrite: `.<final>.<16 hex>.tmp`. */
export const tempNameFor = (finalName: string): string => `.${finalName}.${randomHex(8)}.tmp`

export function isErrno(err: unknown, ...codes: string[]): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    codes.includes(String((err as { code: unknown }).code))
  )
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Windows refuses to replace a file another process has open (Drive's sync
 * client, an editor, antivirus). Those locks are brief, so retry.
 */
async function renameWithRetry(from: string, to: string): Promise<void> {
  const delays = process.platform === 'win32' ? [50, 100, 200, 400, 800] : []
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to)
      return
    } catch (err) {
      const delay = delays[attempt]
      if (delay === undefined || !isErrno(err, 'EPERM', 'EBUSY', 'EACCES')) throw err
      await sleep(delay)
    }
  }
}

/** Create `dir/name` and write `data`, failing with EEXIST if it exists. */
export async function writeNew(
  dir: string,
  name: string,
  data: Uint8Array | string,
  mode = 0o600
): Promise<void> {
  const fh = await open(join(dir, name), 'wx', mode)
  try {
    await fh.writeFile(data)
    await fh.sync()
  } finally {
    await fh.close()
  }
}

/**
 * Write `data` to `dir/finalName` atomically: write a temp file in the same
 * directory (a same-volume rename is what makes this atomic), fsync it, then
 * rename it over the target. The temp file is removed if anything fails.
 * `mode` only has an effect on macOS/Linux; Windows uses the folder's ACL.
 */
export async function atomicWrite(
  dir: string,
  finalName: string,
  data: Uint8Array | string,
  opts: { tmpName?: string; mode?: number } = {}
): Promise<void> {
  const tmpName = opts.tmpName ?? tempNameFor(finalName)
  let written = false
  try {
    await writeNew(dir, tmpName, data, opts.mode ?? 0o600)
    await renameWithRetry(join(dir, tmpName), join(dir, finalName))
    written = true
  } finally {
    if (!written) await rm(join(dir, tmpName), { force: true }).catch(() => undefined)
  }
}
