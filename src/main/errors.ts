import type { AppErrorInfo, ErrorCode } from '../shared/result'

// An error that is safe to show to the user. The message must never contain
// secret values (env contents, passwords, keys).
export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'AppError'
  }
}

export function fail(code: ErrorCode, message: string): { ok: false; error: AppErrorInfo } {
  return { ok: false, error: { code, message } }
}

/**
 * What a caller outside main (the renderer, the envvault command) is told
 * about a failure. `label` names the request in the log line.
 */
export function failureOf(err: unknown, label: string): AppErrorInfo {
  if (err instanceof AppError) return { code: err.code, message: err.message }
  // Node fs errors: report the errno code only (messages contain paths).
  const errno = errnoCode(err)
  if (errno) return { code: 'FS_ERROR', message: `File system error (${errno}).` }
  // Only the error name is logged: messages from JSON.parse and similar
  // can quote the input, which may be secret.
  console.error(`[envvault] ${label} failed: ${err instanceof Error ? err.name : 'unknown'}`)
  return { code: 'INTERNAL', message: 'Unexpected error.' }
}

/** A Node errno code such as ENOENT, or null. */
export function errnoCode(err: unknown): string | null {
  if (typeof err !== 'object' || err === null || !('code' in err)) return null
  const code = (err as { code: unknown }).code
  return typeof code === 'string' && /^E[A-Z]+$/.test(code) ? code : null
}
