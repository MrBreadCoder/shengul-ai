import { AppError } from '@/lib/errors/app-error'

/** Which protocol leg a failure came from. Surfaced to the connect UI. */
export type MailStage = 'smtp' | 'imap'

/** Deadline for any single SMTP or IMAP operation. */
export const MAIL_DEADLINE_MS = 10_000

// The subset of nodemailer's and imapflow's error shapes we branch on.
// Both throw plain Errors decorated with extra fields, so this is read
// defensively rather than validated.
interface MailErrorShape {
  code?: unknown
  responseCode?: unknown
  authenticationFailed?: unknown
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Maps a nodemailer/imapflow failure onto the app's closed AppErrorCode union.
 *
 * `context.status` is deliberately HTTP-shaped so two existing behaviors keep
 * working with no changes at their call sites:
 *   - withRetry retries only 429/5xx, so transient failures land on 503 and
 *     permanent ones on 502.
 *   - sender.ts blocks a mailbox on status 401, so a rotated SMTP password
 *     auto-blocks exactly like a revoked OAuth grant.
 */
export function toMailAppError(error: unknown, stage: MailStage): AppError {
  if (error instanceof AppError) return error

  const raw = (typeof error === 'object' && error !== null ? error : {}) as MailErrorShape
  const code = typeof raw.code === 'string' ? raw.code : undefined
  const responseCode = typeof raw.responseCode === 'number' ? raw.responseCode : undefined
  const cause = messageOf(error)

  // Checked before responseCode: a failed AUTH also carries SMTP reply 535,
  // which would otherwise be mapped as a generic permanent failure and lose
  // the mailbox-blocking signal.
  if (code === 'EAUTH' || code === 'AUTHENTICATIONFAILED' || raw.authenticationFailed === true) {
    return new AppError('UNAUTHORIZED', 'Mailbox credentials were rejected', { status: 401, stage, cause })
  }

  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT') {
    return new AppError('EXTERNAL_TIMEOUT', 'Mail server did not respond in time', { stage, cause })
  }

  if (responseCode !== undefined) {
    // SMTP reply codes are inverted relative to HTTP: 4xx is transient and
    // worth retrying, 5xx is permanent. Translating rather than passing
    // through is the whole point — a naive copy would retry exactly the
    // failures that can never succeed.
    const status = responseCode >= 400 && responseCode < 500 ? 503 : 502
    return new AppError('EXTERNAL_ERROR', 'Mail server rejected the request', {
      status,
      stage,
      responseCode,
      cause,
    })
  }

  return new AppError('EXTERNAL_ERROR', 'Could not reach the mail server', { status: 502, stage, cause })
}

/**
 * Runs a mail operation under a hard deadline. The libraries have their own
 * timeout options, but they do not cover every stage of a connection, and an
 * unbounded wait inside a serverless invocation is worse than a failure.
 */
export async function withMailDeadline<T>(stage: MailStage, run: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new AppError('EXTERNAL_TIMEOUT', 'Mail operation exceeded its deadline', {
          stage,
          timeoutMs: MAIL_DEADLINE_MS,
        }),
      )
    }, MAIL_DEADLINE_MS)
  })

  try {
    return await Promise.race([run(), deadline])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
