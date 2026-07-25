import { isAppError } from '@/lib/errors/app-error'
import { truncate } from '@/lib/format'

// One log row must never carry a multi-kilobyte provider stack trace; the
// operator needs the first line, and the full error still reaches the caller.
const MAX_MESSAGE_CHARS = 300

/** Code used when the thrown value is not one of our own typed errors. */
const UNEXPECTED_CODE = 'UNEXPECTED_ERROR'

export interface ErrorDescription {
  code: string
  message: string
}

/**
 * Normalises anything a `catch` block can receive into the two fields every
 * error log carries. Total and pure by design: it runs inside catch blocks
 * whose job is to report a failure, so it must never create a second one.
 */
export function describeError(error: unknown): ErrorDescription {
  if (isAppError(error)) {
    return { code: error.code, message: truncate(error.message, MAX_MESSAGE_CHARS) }
  }
  if (error instanceof Error) {
    return { code: UNEXPECTED_CODE, message: truncate(error.message, MAX_MESSAGE_CHARS) }
  }
  return { code: UNEXPECTED_CODE, message: truncate(String(error), MAX_MESSAGE_CHARS) }
}
