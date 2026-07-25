import { createAdminClient } from '@/lib/supabase/admin'
import { insertEvent } from '@/lib/db/events'
import { describeError } from './error-context'
import type { Json } from '@/types/database'
import type { LogSeverity, LogSource } from '@/types/logs'

export interface LogEventInput {
  clientId: string | null
  caseId?: string | null
  actor: string
  type: string
  /** Defaults to 'info' — the vast majority of rows are milestones, not problems. */
  severity?: LogSeverity
  /** Defaults to 'app' — an operator/user action rather than a vendor call. */
  source?: LogSource
  payload?: Record<string, Json>
}

// The single audit entry point. Uses the service-role client so audit writes
// are never blocked by RLS. Call after the core action succeeds.
export async function logEvent(input: LogEventInput): Promise<void> {
  const supabase = createAdminClient()
  await insertEvent(supabase, {
    client_id: input.clientId,
    case_id: input.caseId ?? null,
    actor: input.actor,
    type: input.type,
    severity: input.severity ?? 'info',
    source: input.source ?? 'app',
    payload: input.payload ?? {},
  })
}

// Best-effort variant: swallows failures so an audit-log error never fails an
// action that already succeeded (which, on a QStash retry, would needlessly
// re-run it). Use for logging that follows a completed send/DB mutation.
export async function logEventSafe(input: LogEventInput): Promise<void> {
  try {
    await logEvent(input)
  } catch {
    // Audit logging is best-effort; the core action already succeeded.
  }
}

export interface LogFailureInput {
  clientId: string | null
  caseId?: string | null
  actor: string
  type: string
  source: LogSource
  /** Whatever the catch block received. Never assumed to be an Error. */
  error: unknown
  /** Extra structured context merged into the payload. Never secrets. */
  payload?: Record<string, Json>
}

async function logFailure(input: LogFailureInput, severity: 'warn' | 'error'): Promise<void> {
  const { code, message } = describeError(input.error)
  // Always the *safe* variant: every caller is inside a catch block that is
  // about to rethrow, so a logging failure must not replace the real error.
  await logEventSafe({
    clientId: input.clientId,
    caseId: input.caseId ?? null,
    actor: input.actor,
    type: input.type,
    severity,
    source: input.source,
    payload: { ...(input.payload ?? {}), errorCode: code, errorMessage: message },
  })
}

/** Records a failure against a client. Best-effort — never throws. */
export async function logError(input: LogFailureInput): Promise<void> {
  await logFailure(input, 'error')
}

/**
 * Records a degraded-but-handled condition against a client (a send skipped
 * because no mailbox was healthy, a partial agent failure). Best-effort.
 */
export async function logWarn(input: LogFailureInput): Promise<void> {
  await logFailure(input, 'warn')
}
