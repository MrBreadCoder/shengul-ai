import { AppError } from '@/lib/errors/app-error'

/** Days of continuous Mailreach warmup before a mailbox may send campaign mail. */
export const MAILREACH_CAMPAIGN_GATE_DAYS = 14

const MS_PER_DAY = 86_400_000

/**
 * Whole days elapsed since `startedAt`. Clamped at 0 so clock skew (or a start
 * date stamped slightly in the future) never produces a negative count.
 */
export function mailreachElapsedDays(startedAt: string, now: Date): number {
  const startedAtMs = Date.parse(startedAt)
  if (Number.isNaN(startedAtMs)) {
    throw new AppError('INVARIANT_VIOLATION', 'Mailbox mailreach_started_at is not a valid timestamp', {
      startedAt,
    })
  }
  return Math.max(0, Math.floor((now.getTime() - startedAtMs) / MS_PER_DAY))
}

export interface CampaignSendEligibilityInput {
  mailreachEnabled: boolean
  clientMailreachEnabled: boolean
  mailreachStartedAt: string | null
  now: Date
}

/**
 * Whether a mailbox may send campaign (outreach) mail right now. Enrollment is
 * effective only when both the mailbox flag AND the client's master switch are
 * on — a client that has switched Mailreach off is ungated immediately even if
 * a mailbox's own flag or started_at is still stale from before the switch was
 * flipped (see bulkDisconnectForClient, which intentionally leaves per-mailbox
 * mailreach_enabled untouched). Independent of the daily_cap ramp: this is
 * permission to send at all, not how many.
 */
export function isEligibleForCampaignSend(input: CampaignSendEligibilityInput): boolean {
  const effectivelyEnrolled = input.mailreachEnabled && input.clientMailreachEnabled
  if (!effectivelyEnrolled || input.mailreachStartedAt === null) return true
  return mailreachElapsedDays(input.mailreachStartedAt, input.now) >= MAILREACH_CAMPAIGN_GATE_DAYS
}
