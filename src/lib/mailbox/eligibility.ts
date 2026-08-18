import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { listMailboxesByIds, type MailboxRow } from '@/lib/db/mailboxes'
import { isEligibleForCampaignSend, MAILREACH_CAMPAIGN_GATE_DAYS } from '@/lib/mailbox/mailreach-gate'
import { effectiveDailyCap } from '@/lib/mailbox/warmup'

export type OutreachEligibility =
  | { eligible: true }
  | { eligible: false; reason: 'mailreach_gate'; retryAfter: Date }
  | { eligible: false; reason: 'daily_cap'; retryAfter: Date }
  | { eligible: false; reason: 'no_healthy_mailbox' }

const MS_PER_DAY = 86_400_000

// Mirrors claim_mailbox_send's own predicate exactly (migration 0012:
// `health <> 'blocked' and sent_today < least(daily_cap, greatest(p_effective_cap, 0))`)
// — a read-only echo, not the enforcement point. sender.ts's atomic RPC stays
// the real gate; this can race harmlessly (a mailbox counted "capped" here
// may have already reset by the time a real send attempt runs, and vice
// versa) since a wrong "eligible: true" here just falls through to
// sender.ts's real, atomic check.
function isCapReady(mailbox: MailboxRow, now: Date): boolean {
  const cap = Math.min(mailbox.daily_cap, Math.max(effectiveDailyCap({
    profile: mailbox.warmup_profile,
    warmupStartedAt: mailbox.warmup_started_at,
    startCap: mailbox.warmup_start_cap,
    increment: mailbox.warmup_increment,
    targetCap: mailbox.warmup_target_cap,
    dailyCap: mailbox.daily_cap,
    now,
  }), 0))
  return mailbox.sent_today < cap
}

function nextMidnightUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1))
}

function gateLiftsAt(mailbox: MailboxRow): Date {
  // Only called for a mailbox already known to be gated (mailreach_started_at
  // non-null, enrolled) — see call site below.
  return new Date(Date.parse(mailbox.mailreach_started_at!) + MAILREACH_CAMPAIGN_GATE_DAYS * MS_PER_DAY)
}

export async function getOutreachEligibility(
  supabase: SupabaseClient<Database>,
  input: { mailboxIds: string[]; clientMailreachEnabled: boolean; now: Date },
): Promise<OutreachEligibility> {
  const mailboxes = await listMailboxesByIds(supabase, input.mailboxIds)
  const healthy = mailboxes.filter((m) => m.health !== 'blocked')
  if (healthy.length === 0) return { eligible: false, reason: 'no_healthy_mailbox' }

  const gateOk = (m: MailboxRow): boolean =>
    isEligibleForCampaignSend({
      mailreachEnabled: m.mailreach_enabled,
      clientMailreachEnabled: input.clientMailreachEnabled,
      mailreachStartedAt: m.mailreach_started_at,
      now: input.now,
    })

  const gatePassed = healthy.filter(gateOk)
  if (gatePassed.length === 0) {
    // Every healthy mailbox is gated — isEligibleForCampaignSend can only be
    // false when mailreachStartedAt is non-null (see mailreach-gate.ts), so
    // gateLiftsAt is well-defined for each row here. `healthy` is non-empty
    // by construction (the no_healthy_mailbox branch above already returned
    // if it were empty), so reduce without an initial value is safe — no
    // non-null assertion needed.
    const liftTimes = healthy.map(gateLiftsAt)
    const retryAfter = liftTimes.reduce((earliest, t) => (t < earliest ? t : earliest))
    return { eligible: false, reason: 'mailreach_gate', retryAfter }
  }

  if (gatePassed.some((m) => isCapReady(m, input.now))) return { eligible: true }

  // Every gate-cleared mailbox is at today's cap. A diagnostic label only —
  // the retry cadence is the same 5-minute tick regardless of reason.
  return { eligible: false, reason: 'daily_cap', retryAfter: nextMidnightUtc(input.now) }
}
