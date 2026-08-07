import { AppError } from '@/lib/errors/app-error'
import { isValidTimezone } from '@/lib/validation/schedule'

const TIME_OF_DAY_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/
const MS_PER_DAY = 24 * 60 * 60 * 1000

function datePartsIn(instant: Date, timezone: string): { year: number; month: number; day: number } {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  const parts = formatter.formatToParts(instant)
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0)
  return { year: get('year'), month: get('month'), day: get('day') }
}

// Converts a wall-clock date+time in an arbitrary IANA timezone into the
// precise UTC instant it represents. Uses the standard "guess, observe,
// correct" technique: treat the wall clock as if it were UTC to get a
// starting instant, format that instant back in the target timezone to see
// what it actually reads as there, and shift by the difference. Two passes
// handle the rare case where the first correction itself crosses a DST
// boundary.
function zonedWallClockToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timezone: string,
): Date {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })

  // `desiredMs` is the fixed target (the wall clock we want, read as if it
  // were UTC) — every pass must correct back toward *that*, not toward
  // whatever the previous pass's candidate was, or the correction diverges
  // by the zone's offset instead of converging to it.
  const desiredMs = Date.UTC(year, month - 1, day, hour, minute, 0)
  let candidateMs = desiredMs
  for (let pass = 0; pass < 2; pass += 1) {
    const parts = formatter.formatToParts(new Date(candidateMs))
    const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0)
    const shownMs = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'))
    const diffMs = desiredMs - shownMs
    if (diffMs === 0) break
    candidateMs += diffMs
  }
  return new Date(candidateMs)
}

/**
 * Computes the next UTC instant at which `timeOfDay` (wall clock, "HH:mm")
 * occurs in `timezone`, strictly after `fromUtc`. If today's occurrence in
 * that timezone is still in the future, returns today's; otherwise advances
 * one calendar day *in that timezone* and recomputes — so a DST transition
 * shifts the resulting UTC instant correctly instead of the offset silently
 * carrying over from the previous day.
 *
 * Pure function, no I/O. Throws INVARIANT_VIOLATION for malformed input —
 * callers (routes, Server Actions) are expected to validate with
 * `timeOfDaySchema`/`timezoneSchema` before calling this, so a failure here
 * signals a programming bug, not a user input error.
 */
export function computeNextRunAt(fromUtc: Date, timeOfDay: string, timezone: string): Date {
  const match = TIME_OF_DAY_PATTERN.exec(timeOfDay)
  const hourStr = match?.[1]
  const minuteStr = match?.[2]
  if (!hourStr || !minuteStr) {
    throw new AppError('INVARIANT_VIOLATION', 'computeNextRunAt received a malformed timeOfDay', { timeOfDay })
  }
  if (!isValidTimezone(timezone)) {
    throw new AppError('INVARIANT_VIOLATION', 'computeNextRunAt received an unrecognized timezone', { timezone })
  }
  const hour = Number(hourStr)
  const minute = Number(minuteStr)

  const today = datePartsIn(fromUtc, timezone)
  const todayCandidate = zonedWallClockToUtc(today.year, today.month, today.day, hour, minute, timezone)
  if (todayCandidate.getTime() > fromUtc.getTime()) {
    return todayCandidate
  }

  // Today's occurrence already passed (or is exactly now) — advance one real
  // day from today's already-correct instant, then re-derive the calendar
  // date in the target timezone from that point. A plain +24h on the final
  // answer would be wrong across a DST transition; deriving the date this
  // way and re-running zonedWallClockToUtc for it is what makes the offset
  // recompute correctly.
  const tomorrowGuess = new Date(todayCandidate.getTime() + MS_PER_DAY)
  const tomorrow = datePartsIn(tomorrowGuess, timezone)
  return zonedWallClockToUtc(tomorrow.year, tomorrow.month, tomorrow.day, hour, minute, timezone)
}
