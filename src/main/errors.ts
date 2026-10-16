import type { ErrorCode } from '../shared/result'

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
