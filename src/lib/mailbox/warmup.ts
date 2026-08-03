import type { Database } from '@/types/database'
import { AppError } from '@/lib/errors/app-error'

export type WarmupProfile = Database['public']['Enums']['warmup_profile']

/**
 * Days a mailbox holds each level before stepping up. 'standard' steps daily
 * (start, start+increment, start+2*increment, ...); 'slow' holds each level
 * for two days, for a domain that needs a gentler ramp; 'none' is an
 * already-warm mailbox and skips the ramp entirely.
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
  /** Day-one send allowance, per mailbox (replaces the old global WARMUP_START_CAP). */
  startCap: number
  /** Sends added at each step of the ramp, per mailbox (replaces WARMUP_INCREMENT). */
  increment: number
  /** The ramp ceiling — once the computed ramp value reaches this, the mailbox is "Already warm". */
  targetCap: number
  /** The already-warm cap: served directly for profile 'none', and once the ramp completes. */
  dailyCap: number
  now: Date
}

interface RampState {
  rampValue: number
  elapsedDays: number
}

/**
 * Shared by effectiveDailyCap and getMailboxWarmthStatus so the elapsed-time
 * and ramp-value math lives once. Returns null when the mailbox isn't
 * ramping at all (profile 'none', or warmup never started).
 */
function computeRampState(input: EffectiveCapInput): RampState | null {
  const stepDays = WARMUP_STEP_DAYS[input.profile]
  if (stepDays === 0 || input.warmupStartedAt === null) return null

  const startedAt = Date.parse(input.warmupStartedAt)
  if (Number.isNaN(startedAt)) {
    throw new AppError('INVARIANT_VIOLATION', 'Mailbox warmup_started_at is not a valid timestamp', {
      warmupStartedAt: input.warmupStartedAt,
    })
  }

  // Clamped at 0 so clock skew (or a start date stamped slightly in the future)
  // opens the mailbox at the start cap rather than a negative one.
  const elapsedDays = Math.max(0, Math.floor((input.now.getTime() - startedAt) / MS_PER_DAY))
  const steps = Math.floor(elapsedDays / stepDays)
  return { rampValue: input.startCap + input.increment * steps, elapsedDays }
}

/**
 * Today's send allowance for one mailbox. Fully derived — once the ramp value
 * reaches targetCap, this starts returning dailyCap (the already-warm cap) on
 * every subsequent call, with nothing persisted. Raising targetCap later
 * simply makes the ramp resume on the next call.
 */
export function effectiveDailyCap(input: EffectiveCapInput): number {
  const state = computeRampState(input)
  if (state === null) return input.dailyCap
  return state.rampValue >= input.targetCap ? input.dailyCap : state.rampValue
}

export type WarmthStatus =
  | { kind: 'not_ramping' }
  | { kind: 'ramping'; currentCap: number; dayNumber: number }
  | { kind: 'ramp_complete' }

/**
 * Display-only status for the settings screen and the Clients-page Warmup
 * tab, so both surfaces label a mailbox "Already warm" the same way whether
 * it was set to 'none' directly or got there by finishing its ramp.
 */
export function getMailboxWarmthStatus(input: EffectiveCapInput): WarmthStatus {
  const state = computeRampState(input)
  if (state === null) return { kind: 'not_ramping' }
  if (state.rampValue >= input.targetCap) return { kind: 'ramp_complete' }
  return { kind: 'ramping', currentCap: state.rampValue, dayNumber: state.elapsedDays + 1 }
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
