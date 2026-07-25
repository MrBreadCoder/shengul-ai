import type { Database } from '@/types/database'

export type MailboxHealth = Database['public']['Enums']['mailbox_health']

/**
 * Machine-readable values for mailboxes.health_reason. The operator UI and the
 * runbook branch on these, so they are stable strings, not prose.
 */
export const HEALTH_REASON = {
  bounceRateHigh: 'bounce_rate_high',
  bounceRateElevated: 'bounce_rate_elevated',
  bounceRateNormal: 'bounce_rate_normal',
  operatorPaused: 'operator_paused',
  authFailure: 'auth_failure',
} as const

/** Rolling window the bounce rate is measured over. */
export const HEALTH_WINDOW_DAYS = 7

/**
 * Below this many sends in the window the rate is noise — three sends and one
 * bad address is not a 33% bounce rate worth pausing a mailbox over.
 */
export const MIN_SENDS_FOR_HEALTH = 20

/** 2026 consensus: under 2% is healthy, 3%+ puts domain reputation at risk. */
export const BOUNCE_WARNING_RATE = 0.03

/** 5%+ is the "stop sending immediately and clean the list" line. */
export const BOUNCE_BLOCK_RATE = 0.05

export interface HealthVerdict {
  health: MailboxHealth
  reason: string
}

export interface BounceHealthInput {
  current: MailboxHealth
  sentCount: number
  bouncedCount: number
}

/**
 * The health a mailbox should have given its recent hard-bounce rate, or null
 * when the current health should be left alone.
 *
 * A blocked mailbox never auto-recovers: bad sends age out of the window on
 * their own, so an automatic un-block would resume sending into a mailbox
 * nobody has looked at. Recovering `warning -> ok` is safe because a warning
 * mailbox is still sending anyway.
 */
export function evaluateBounceHealth({ current, sentCount, bouncedCount }: BounceHealthInput): HealthVerdict | null {
  if (current === 'blocked') return null
  if (sentCount < MIN_SENDS_FOR_HEALTH) return null

  const rate = bouncedCount / sentCount

  if (rate >= BOUNCE_BLOCK_RATE) {
    return { health: 'blocked', reason: HEALTH_REASON.bounceRateHigh }
  }
  if (rate >= BOUNCE_WARNING_RATE) {
    return current === 'warning' ? null : { health: 'warning', reason: HEALTH_REASON.bounceRateElevated }
  }
  return current === 'warning' ? { health: 'ok', reason: HEALTH_REASON.bounceRateNormal } : null
}
