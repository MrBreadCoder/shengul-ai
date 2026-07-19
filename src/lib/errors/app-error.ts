export type AppErrorCode =
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'RATE_LIMITED'
  | 'EXTERNAL_TIMEOUT'
  | 'EXTERNAL_ERROR'
  | 'DB_ERROR'
  | 'CONFIG_ERROR'
  | 'INVARIANT_VIOLATION'

export class AppError extends Error {
  public readonly code: AppErrorCode
  public readonly context: Record<string, unknown>

  constructor(code: AppErrorCode, message: string, context: Record<string, unknown> = {}) {
    super(message)
    this.name = 'AppError'
    this.code = code
    this.context = context
    Object.setPrototypeOf(this, AppError.prototype)
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError
}
