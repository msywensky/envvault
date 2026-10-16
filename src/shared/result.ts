// Every IPC call resolves to a Result. Errors carry a stable code and a
// human-readable message that never contains secret values.

export type ErrorCode = 'BAD_REQUEST' | 'FORBIDDEN' | 'INTERNAL'

export interface AppErrorInfo {
  code: ErrorCode
  message: string
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: AppErrorInfo }
