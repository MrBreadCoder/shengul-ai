import { publishJsonWithDelay } from '@/lib/qstash/client'
import { logError, logWarn } from '@/lib/events/log-event'

// 5 minutes — long enough that a Gemini "high demand" spike has a real
// chance to clear, short enough a case isn't idle for long. Deliberately
// NOT an in-process sleep: a serverless route can't hold a connection open
// for 5 minutes, so this is a QStash-scheduled redelivery of the same route
// instead — the same primitive followup.ts already uses for its 3/7/14-day
// cadence, just at a much shorter delay.
export const OVERLOAD_RETRY_DELAY_SECONDS = 300

// 5 long-retries x 5 min = ~25 more minutes of runway on top of the AI SDK's
// own fast (sub-second, maxRetries: 2) built-in retries, before this gives
// up hammering a still-down model on a fixed clock and falls back to
// stuck-sweep's much slower (30+ min) cadence instead.
export const MAX_OVERLOAD_RETRIES = 5

export interface OverloadRetryInput {
  /** The route to redeliver to, e.g. '/api/pipeline/research'. */
  path: string
  caseId: string
  clientId: string | null
  actor: string
  /** Prefixes every event type this logs, e.g. 'pipeline.research'. */
  eventPrefix: string
  /** Long-retries already spent on this case — 0 on the first overload. */
  retryCount: number
  /** The overload error that triggered this call — logged, not inspected further (isModelOverloadedError already made that call). */
  error: unknown
  /**
   * Reverts the route's in-progress claim (e.g. 'researching' -> 'new') so
   * the case reads honestly on the CRM board while the retry is pending,
   * and so the redelivered request's own status guard doesn't just skip it
   * as already-claimed.
   */
  revert: () => Promise<void>
}

export type OverloadRetryOutcome =
  | { scheduled: true; nextRetryCount: number }
  | { scheduled: false }

// Called from a pipeline route's catch block once isModelOverloadedError()
// has confirmed the failure is worth a long retry. Reverts the in-progress
// claim and schedules a delayed QStash redelivery of the same case to the
// same route, capped at MAX_OVERLOAD_RETRIES — past the cap (or if
// scheduling itself fails) this gives up for now and leaves the case
// claimed for stuck-sweep's slower cadence to eventually recover, rather
// than hammering a sustained outage forever on a fixed 5-minute clock.
// Never throws — every failure path here is logged and absorbed, since a
// secondary failure while already handling a failure must never mask the
// original one or crash the route.
export async function handleModelOverload(input: OverloadRetryInput): Promise<OverloadRetryOutcome> {
  try {
    await input.revert()
  } catch (revertError) {
    // Best-effort: even if this fails the case is still recoverable, just
    // later — the delayed retry below either lands on a status its own
    // claim-guard rejects (safe no-op) or stuck-sweep eventually resets it.
    await logWarn({
      clientId: input.clientId,
      caseId: input.caseId,
      actor: input.actor,
      type: `${input.eventPrefix}.overload_revert_failed`,
      source: 'pipeline',
      error: revertError,
      payload: { caseId: input.caseId },
    })
  }

  if (input.retryCount >= MAX_OVERLOAD_RETRIES) {
    await logError({
      clientId: input.clientId,
      caseId: input.caseId,
      actor: input.actor,
      type: `${input.eventPrefix}.overload_exhausted`,
      source: 'pipeline',
      error: input.error,
      payload: { caseId: input.caseId, retryCount: input.retryCount },
    })
    return { scheduled: false }
  }

  const nextRetryCount = input.retryCount + 1
  try {
    await publishJsonWithDelay(
      input.path,
      { caseId: input.caseId, retryCount: nextRetryCount },
      OVERLOAD_RETRY_DELAY_SECONDS,
    )
  } catch (publishError) {
    await logError({
      clientId: input.clientId,
      caseId: input.caseId,
      actor: input.actor,
      type: `${input.eventPrefix}.overload_retry_schedule_failed`,
      source: 'pipeline',
      error: publishError,
      payload: { caseId: input.caseId, retryCount: nextRetryCount },
    })
    return { scheduled: false }
  }

  await logWarn({
    clientId: input.clientId,
    caseId: input.caseId,
    actor: input.actor,
    type: `${input.eventPrefix}.overload_retry_scheduled`,
    source: 'pipeline',
    error: input.error,
    payload: { caseId: input.caseId, retryCount: nextRetryCount, delaySeconds: OVERLOAD_RETRY_DELAY_SECONDS },
  })
  return { scheduled: true, nextRetryCount }
}
