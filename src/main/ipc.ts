import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { fileURLToPath } from 'node:url'
import { is } from '@electron-toolkit/utils'
import type { z } from 'zod'
import type { Responses } from '../shared/api'
import { requestSchemas } from './schemas'
import type { AppErrorInfo, ErrorCode, Result } from '../shared/result'
import { AppError } from './errors'
import { getMainWindow, RENDERER_INDEX } from './window'

type Schemas = typeof requestSchemas
type HandledChannel = keyof Schemas & keyof Responses

// Called after a request passes the sender check and validation. The session
// uses it to reset the idle auto-lock timer.
export const ipcHooks: { onAuthorizedCall?: () => void } = {}

export function handle<C extends HandledChannel>(
  channel: C,
  fn: (input: z.infer<Schemas[C]>) => Promise<Responses[C]> | Responses[C]
): void {
  // TS can't relate a generic index into the schema map to its inferred type.
  const schema = requestSchemas[channel] as unknown as z.ZodType<z.infer<Schemas[C]>>
  ipcMain.handle(channel, async (event, raw: unknown): Promise<Result<Responses[C]>> => {
    // Everything is inside the try so the renderer always receives a Result.
    try {
      if (!isTrustedSender(event)) return fail('FORBIDDEN', 'Request rejected.')
      const parsed = schema.safeParse(raw)
      // zod messages can echo the received input, so don't forward them.
      if (!parsed.success) return fail('BAD_REQUEST', 'Invalid request.')
      ipcHooks.onAuthorizedCall?.()
      return { ok: true, data: await fn(parsed.data) }
    } catch (err) {
      if (err instanceof AppError) return fail(err.code, err.message)
      // Node fs errors: report the errno code only (messages contain paths).
      const errno = errnoCode(err)
      if (errno) return fail('FS_ERROR', `File system error (${errno}).`)
      // Only the error name is logged: messages from JSON.parse and similar
      // can quote the input, which may be secret.
      console.error(`[envvault] ${channel} failed: ${err instanceof Error ? err.name : 'unknown'}`)
      return fail('INTERNAL', 'Unexpected error.')
    }
  })
}

function errnoCode(err: unknown): string | null {
  if (typeof err !== 'object' || err === null || !('code' in err)) return null
  const code = (err as { code: unknown }).code
  return typeof code === 'string' && /^E[A-Z]+$/.test(code) ? code : null
}

function fail(code: ErrorCode, message: string): { ok: false; error: AppErrorInfo } {
  return { ok: false, error: { code, message } }
}

function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  const win = getMainWindow()
  if (!win || event.sender !== win.webContents) return false
  const frame = event.senderFrame
  if (!frame || frame.parent !== null) return false
  return isAppUrl(frame.url)
}

export function isAppUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    const devUrl = process.env['ELECTRON_RENDERER_URL']
    if (is.dev && devUrl) return parsed.origin === new URL(devUrl).origin
    if (parsed.protocol !== 'file:') return false
    const actual = fileURLToPath(parsed)
    return process.platform === 'win32'
      ? actual.toLowerCase() === RENDERER_INDEX.toLowerCase()
      : actual === RENDERER_INDEX
  } catch {
    return false
  }
}
