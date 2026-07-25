import type { Database } from '@/types/database'
import { AppError } from '@/lib/errors/app-error'

export type WarmupProfile = Database['public']['Enums']['warmup_profile']

/**
 * Day-one send allowance for a ramping mailbox. 2026 deliverability consensus
 * is to open a new mailbox at 5-10 sends/day and ramp over 2-4 weeks.
 */
export const WARMUP_START_CAP = 5

/** Sends added at each step of the ramp. */
export const WARMUP_INCREMENT = 3

/**
 * Days a mailbox holds each level before stepping up. 'standard' steps daily
 * (5, 8, 11, ...); 'slow' holds each level for two days (5, 5, 8, 8, ...) for a
 * domain that needs a gentler ramp; 'none' is an already-warm mailbox and skips
 * the ramp entirely.
 */
export const WARMUP_STEP_DAYS: Record<WarmupProfile, number> = {
  standard: 1,
  slow: 2,
  none: 0,
}

const MS_PER_DAY = 86_400_000

export interface EffectiveCapInput {
  profile: WarmupProfile
  warmupStartedAt: string | null
  dailyCap: number
  now: Date
}

/**
 * Today's send allowance for one mailbox: the ramp level, never above the
 * operator-configured `daily_cap`. Pure so it can be exhaustively tested; the
 * atomic enforcement lives in the claim_mailbox_send RPC, which takes this
 * number and clamps it with `least(daily_cap, ...)`.
 */
export function effectiveDailyCap({ profile, warmupStartedAt, dailyCap, now }: EffectiveCapInput): number {
  const stepDays = WARMUP_STEP_DAYS[profile]
  if (stepDays === 0 || warmupStartedAt === null) return dailyCap

  const startedAt = Date.parse(warmupStartedAt)
  if (Number.isNaN(startedAt)) {
    throw new AppError('INVARIANT_VIOLATION', 'Mailbox warmup_started_at is not a valid timestamp', {
      warmupStartedAt,
    })
  }

  // Clamped at 0 so clock skew (or a start date stamped slightly in the future)
  // opens the mailbox at the start cap rather than a negative one.
  const elapsedDays = Math.floor((now.getTime() - startedAt) / MS_PER_DAY)
  const steps = Math.max(0, Math.floor(elapsedDays / stepDays))
  return Math.min(dailyCap, WARMUP_START_CAP + WARMUP_INCREMENT * steps)
}

/**
 * The warmup columns to write when a mailbox is connected or its profile is
 * changed. Shared by both OAuth callbacks and the per-mailbox override route so
 * the "ramping profiles get a start date, 'none' does not" rule lives once.
 */
export function warmupInsertFields(
  profile: WarmupProfile,
  now: Date,
): { warmup_profile: WarmupProfile; warmup_started_at: string | null } {
  return {
    warmup_profile: profile,
    warmup_started_at: profile === 'none' ? null : now.toISOString(),
  }
}
