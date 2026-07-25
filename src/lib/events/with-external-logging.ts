import { logError } from './log-event'
import type { Json } from '@/types/database'
import type { LogSource } from '@/types/logs'

export interface ExternalCallContext {
  clientId: string | null
  caseId?: string | null
  actor: string
  /** Dotted event type recorded on failure, e.g. `apollo.search.failed`. */
  failureType: string
  /** Extra structured fields merged into the failure payload. Never secrets. */
  payload?: Record<string, Json>
}

/**
 * Runs one external-vendor call, attributing any failure to a client before
 * rethrowing it untouched. This adds only the audit row that makes a vendor
 * outage visible on the client's Logs tab — error handling, retries and
 * status-code branching all stay with the caller.
 */
export async function withExternalLogging<T>(
  source: LogSource,
  context: ExternalCallContext,
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await work()
  } catch (error) {
    // logError is best-effort and never throws, so the rethrow below is always
    // reached with the original error.
    await logError({
      clientId: context.clientId,
      caseId: context.caseId ?? null,
      actor: context.actor,
      type: context.failureType,
      source,
      error,
      payload: context.payload,
    })
    throw error
  }
}
