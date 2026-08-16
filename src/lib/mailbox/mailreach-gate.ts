import { AppError } from '@/lib/errors/app-error'
import type { MailboxRow } from '@/lib/db/mailboxes'

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

export interface MailboxWarmupInfo {
  mailboxId: string
  emailAddress: string
  /** Whole days elapsed since warmup started — 0 on the start day. Drives gating/ordering, not display. */
  elapsedDays: number
  /**
   * 1-indexed day number for display ("Day 1" on the start day) —
   * `elapsedDays + 1`. Matches the daily-cap ramp's dayNumber
   * (lib/mailbox/warmup.ts's getMailboxWarmthStatus) so every "Day N" shown
   * to a client means the same thing across the app.
   */
  dayNumber: number
  gateDays: number
  isGated: boolean
  reputationScore: number | null
  totalMessagesSent: number | null
  totalMessagesReceived: number | null
  totalSpam: number | null
  currentConversations: number | null
}

export type MailboxWarmupSource = Pick<
  MailboxRow,
  | 'id'
  | 'email_address'
  | 'mailreach_enabled'
  | 'mailreach_started_at'
  | 'mailreach_status'
  | 'mailreach_reputation_score'
  | 'mailreach_total_messages_sent'
  | 'mailreach_total_messages_received'
  | 'mailreach_total_spam'
  | 'mailreach_current_conversations'
>

/**
 * Every currently-connected, enrolled mailbox in `mailboxes`, gated or not.
 * Callers filter to `.isGated` themselves for "still warming" surfaces (home
 * banner, report trigger) — Analytics wants the full list including mailboxes
 * that already cleared the gate ("Warm").
 */
export function summarizeMailboxWarmup(
  mailboxes: MailboxWarmupSource[],
  clientMailreachEnabled: boolean,
  now: Date,
): MailboxWarmupInfo[] {
  const summaries: MailboxWarmupInfo[] = []
  for (const mailbox of mailboxes) {
    if (!mailbox.mailreach_enabled || !clientMailreachEnabled) continue
    if (mailbox.mailreach_status !== 'connected') continue
    if (mailbox.mailreach_started_at === null) continue
    const elapsedDays = mailreachElapsedDays(mailbox.mailreach_started_at, now)
    summaries.push({
      mailboxId: mailbox.id,
      emailAddress: mailbox.email_address,
      elapsedDays,
      dayNumber: elapsedDays + 1,
      gateDays: MAILREACH_CAMPAIGN_GATE_DAYS,
      isGated: elapsedDays < MAILREACH_CAMPAIGN_GATE_DAYS,
      reputationScore: mailbox.mailreach_reputation_score,
      totalMessagesSent: mailbox.mailreach_total_messages_sent,
      totalMessagesReceived: mailbox.mailreach_total_messages_received,
      totalSpam: mailbox.mailreach_total_spam,
      currentConversations: mailbox.mailreach_current_conversations,
    })
  }
  return summaries
}

/** The mailbox nearest to clearing the gate — null when none are gated. */
export function closestToReady(gated: MailboxWarmupInfo[]): MailboxWarmupInfo | null {
  if (gated.length === 0) return null
  return gated.reduce((closest, current) => (current.elapsedDays > closest.elapsedDays ? current : closest))
}

/** Sum of sent + received across the given mailboxes, treating null as 0. */
export function totalMessagesExchanged(mailboxes: MailboxWarmupInfo[]): number {
  return mailboxes.reduce((sum, m) => sum + (m.totalMessagesSent ?? 0) + (m.totalMessagesReceived ?? 0), 0)
}
