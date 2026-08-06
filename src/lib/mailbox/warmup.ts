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

// Mirrors `mailboxes.daily_cap`'s own column default (migration 0001) — kept
// as a named constant here because `warmup_target_cap` has no column default
// of its own (migration 0024, deliberately: it's meant to be an explicit
// per-mailbox value). A newly connected mailbox has no daily_cap override
// yet, so its target cap should start equal to the daily_cap it will
// actually get, matching the pre-0024 behavior where the ramp's implicit
// target was always daily_cap itself.
export const DEFAULT_MAILBOX_DAILY_CAP = 20

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
 * and ramp-value math lives once. Returns null only for profile 'none',
 * which never ramps (WARMUP_STEP_DAYS.none === 0). A ramping profile with no
 * `warmupStartedAt` yet — the mailbox is connected but has never actually
 * sent anything (see migration 0030's lazy stamp in claim_mailbox_send /
 * claim_mailbox_send_uncapped) — is day one of the ramp with the clock not
 * running yet: it returns the day-one allowance, not null, so a caller can't
 * mistake "hasn't sent yet" for "already warm".
 */
function computeRampState(input: EffectiveCapInput): RampState | null {
  const stepDays = WARMUP_STEP_DAYS[input.profile]
  if (stepDays === 0) return null

  if (input.warmupStartedAt === null) {
    return { rampValue: input.startCap, elapsedDays: 0 }
  }

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
 * simply makes the ramp resume on the next call. For a ramping profile that
 * has never sent, this returns startCap — the same number the mailbox's
 * literal first send will ramp from.
 */
export function effectiveDailyCap(input: EffectiveCapInput): number {
  const state = computeRampState(input)
  if (state === null) return input.dailyCap
  return state.rampValue >= input.targetCap ? input.dailyCap : state.rampValue
}

export type WarmthStatus =
  | { kind: 'not_ramping' }
  | { kind: 'not_started'; startCap: number }
  | { kind: 'ramping'; currentCap: number; dayNumber: number }
  | { kind: 'ramp_complete' }

/**
 * Display-only status for the settings screen and the Clients-page Warmup
 * tab, so both surfaces label a mailbox the same way. 'not_started' (ramping
 * profile, never sent — see computeRampState) is a distinct variant from
 * 'not_ramping' (profile 'none') so the UI never mislabels a mailbox that
 * simply hasn't sent its first email yet as "already warm".
 */
export function getMailboxWarmthStatus(input: EffectiveCapInput): WarmthStatus {
  const stepDays = WARMUP_STEP_DAYS[input.profile]
  if (stepDays === 0) return { kind: 'not_ramping' }
  if (input.warmupStartedAt === null) return { kind: 'not_started', startCap: input.startCap }

  // Non-null is guaranteed here: computeRampState only returns null when
  // stepDays === 0, already handled above, or (unreachably, since we just
  // checked it) warmupStartedAt === null.
  const state = computeRampState(input)!
  if (state.rampValue >= input.targetCap) return { kind: 'ramp_complete' }
  return { kind: 'ramping', currentCap: state.rampValue, dayNumber: state.elapsedDays + 1 }
}

/**
 * The warmup columns to write when a mailbox is newly connected (the three
 * OAuth/SMTP connect routes). The ramp clock does not start here — it starts
 * lazily on the mailbox's first actual send (migration 0030's
 * claim_mailbox_send / claim_mailbox_send_uncapped), so a freshly connected
 * mailbox always begins with a null started_at, whatever its profile.
 */
export function warmupInsertFields(
  profile: WarmupProfile,
): { warmup_profile: WarmupProfile; warmup_started_at: null } {
  return { warmup_profile: profile, warmup_started_at: null }
}

/**
 * The warmup columns to write when an operator explicitly changes a
 * mailbox's profile (POST /api/mailboxes/[id]/warmup). Unlike
 * warmupInsertFields, this restarts the ramp immediately — a profile change
 * is a deliberate "re-warm starting now" action (reconnected, previously
 * blocked, new domain), not a "wait for the next send" one.
 */
export function warmupRestartFields(
  profile: WarmupProfile,
  now: Date,
): { warmup_profile: WarmupProfile; warmup_started_at: string | null } {
  return {
    warmup_profile: profile,
    warmup_started_at: profile === 'none' ? null : now.toISOString(),
  }
}
