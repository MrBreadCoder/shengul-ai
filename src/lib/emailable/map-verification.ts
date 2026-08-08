import type { Database, Json } from '@/types/database'
import type { VerificationOutcome } from './types'

type LeadEmailStatus = Database['public']['Enums']['lead_email_status']
type LeadStatus = Database['public']['Enums']['lead_status']

export interface LeadVerificationVerdict {
  emailStatus: LeadEmailStatus
  leadStatus: LeadStatus
  /** Written verbatim to leads.email_verification. */
  verification: Json
}

// Emailable's documented /v1/verify states. `duplicate` is deliberately absent:
// it only occurs in uploaded batch lists, so on this endpoint it falls through
// to the unrecognized-state branch and parks, which is the correct outcome.
const STATE_MAP: Record<string, LeadEmailStatus> = {
  deliverable: 'verified',
  undeliverable: 'invalid',
  risky: 'risky',
  unknown: 'unverified',
}

// The parsed response came off the wire as JSON, so it is JSON-serialisable by
// construction — this round-trip only re-expresses that fact in a type the
// jsonb column accepts, without an `as` cast that could hide a real mismatch.
function toJson(value: unknown): Json {
  return JSON.parse(JSON.stringify(value)) as Json
}

/**
 * The whole send policy. Input is always a lead Apollo already marked
 * `verified` with a non-empty email — the caller guarantees that, because
 * Emailable is never called for any other lead.
 *
 * Emailable only ever narrows: it can demote a lead Apollo verified, never
 * promote one Apollo did not. `deliverable` activates, and so does the one
 * carve-out below (`risky` + `low_deliverability` + `accept_all`) — every
 * other verdict parks.
 *
 * A state we do not recognise parks the lead. That is deliberate and is NOT
 * the same as the fail-open branch below: an unrecognised state is a definite
 * answer we cannot interpret, so the safe reading is "not proven deliverable".
 * Fail-open applies only to the absence of an answer.
 */
export function mapEmailableVerdict(
  outcome: VerificationOutcome,
  checkedAt: string,
): LeadVerificationVerdict {
  // Blanket fail open, by explicit operator decision: any failure — including a
  // persistent 402 (out of credits) or 403 (bad key) — falls back to Apollo's
  // verdict rather than stalling discovery. `verification` is the only durable
  // record that this lead was never actually guarded.
  if (!outcome.ok) {
    return {
      emailStatus: 'verified',
      leadStatus: 'active',
      verification: { provider: 'emailable', outcome: 'failed', error: outcome.error, checkedAt },
    }
  }

  const state = outcome.result.state.toLowerCase().trim()
  const emailStatus = STATE_MAP[state] ?? 'unverified'
  const reason = outcome.result.reason?.toLowerCase().trim()

  // Carve-out: a `risky`/`low_deliverability` verdict on a domain Emailable
  // itself reports as `accept_all` means the mail server accepts every
  // address — Emailable cannot confirm this specific mailbox either way, so
  // the verdict is "unconfirmable", not "bad". Apollo already verified this
  // address once; parking it here would discard a working lead on nothing
  // more than the domain's own catch-all configuration. In production this
  // was the entire `risky` bucket (100% of a sampled batch), which is why it
  // was silently discarding most of the pipeline's verified yield — see
  // docs/superpowers/plans/2026-08-08-emailable-accept-all-catch-all.md.
  // `low_quality` risky results (role/disposable-style signals) are a
  // different, genuine quality concern and are NOT covered by this
  // carve-out — they stay parked regardless of accept_all.
  const isUnconfirmableCatchAll =
    emailStatus === 'risky' && reason === 'low_deliverability' && outcome.result.accept_all === true

  return {
    emailStatus,
    leadStatus: emailStatus === 'verified' || isUnconfirmableCatchAll ? 'active' : 'parked',
    verification: toJson({
      provider: 'emailable',
      outcome: 'checked',
      checkedAt,
      ...outcome.result,
    }),
  }
}
