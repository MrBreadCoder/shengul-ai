import { describe, it, expect } from 'vitest'
import { computeNextRunAt } from './next-run'
import { AppError } from '@/lib/errors/app-error'

describe('computeNextRunAt', () => {
  it("should return today's occurrence when it has not happened yet, UTC", () => {
    const from = new Date('2026-06-15T00:00:00Z')
    const result = computeNextRunAt(from, '06:00', 'UTC')
    expect(result.toISOString()).toBe('2026-06-15T06:00:00.000Z')
  })

  it("should roll to tomorrow when today's occurrence has already passed, UTC", () => {
    const from = new Date('2026-06-15T07:00:00Z')
    const result = computeNextRunAt(from, '06:00', 'UTC')
    expect(result.toISOString()).toBe('2026-06-16T06:00:00.000Z')
  })

  it('should roll across a month boundary', () => {
    const from = new Date('2026-01-31T23:00:00Z')
    const result = computeNextRunAt(from, '06:00', 'UTC')
    expect(result.toISOString()).toBe('2026-02-01T06:00:00.000Z')
  })

  it('should roll to tomorrow when fromUtc exactly equals the candidate instant', () => {
    // Matches listCampaignsDueForDiscovery's lte() semantics: a campaign
    // fired at exactly its due instant must not be immediately due again.
    const from = new Date('2026-06-15T06:00:00.000Z')
    const result = computeNextRunAt(from, '06:00', 'UTC')
    expect(result.toISOString()).toBe('2026-06-16T06:00:00.000Z')
  })

  it('should convert a non-UTC, non-DST timezone correctly', () => {
    // Asia/Tokyo has no DST — a fixed UTC+9 offset year-round. `from` is
    // deliberately 1h before the target instant (rather than exactly equal
    // to it) so this test exercises the offset conversion, not the
    // exactly-equal boundary case covered separately above.
    const from = new Date('2026-06-14T23:00:00Z')
    const result = computeNextRunAt(from, '09:00', 'Asia/Tokyo')
    expect(result.toISOString()).toBe('2026-06-15T00:00:00.000Z')
  })

  it('should shift the UTC offset correctly across a US spring-forward transition', () => {
    // 2026-03-08: America/New_York goes from EST (UTC-5) to EDT (UTC-4) at 02:00 local.
    const beforeTransition = computeNextRunAt(new Date('2026-03-07T00:00:00Z'), '06:00', 'America/New_York')
    expect(beforeTransition.toISOString()).toBe('2026-03-07T11:00:00.000Z') // 06:00 EST = 11:00 UTC

    const onTransitionDay = computeNextRunAt(new Date('2026-03-08T00:00:00Z'), '06:00', 'America/New_York')
    expect(onTransitionDay.toISOString()).toBe('2026-03-08T10:00:00.000Z') // 06:00 EDT = 10:00 UTC
  })

  it('should shift the UTC offset correctly across a US fall-back transition', () => {
    // 2026-11-01: America/New_York goes from EDT (UTC-4) back to EST (UTC-5) at 02:00 local.
    const beforeTransition = computeNextRunAt(new Date('2026-10-31T00:00:00Z'), '06:00', 'America/New_York')
    expect(beforeTransition.toISOString()).toBe('2026-10-31T10:00:00.000Z') // 06:00 EDT = 10:00 UTC

    const onTransitionDay = computeNextRunAt(new Date('2026-11-01T00:00:00Z'), '06:00', 'America/New_York')
    expect(onTransitionDay.toISOString()).toBe('2026-11-01T11:00:00.000Z') // 06:00 EST = 11:00 UTC
  })

  it('should throw INVARIANT_VIOLATION for a malformed timeOfDay', () => {
    expect(() => computeNextRunAt(new Date(), '25:00', 'UTC')).toThrow(AppError)
    expect(() => computeNextRunAt(new Date(), '9:00', 'UTC')).toThrow(AppError)
    expect(() => computeNextRunAt(new Date(), 'not-a-time', 'UTC')).toThrow(AppError)
  })

  it('should throw INVARIANT_VIOLATION for an unrecognized timezone', () => {
    expect(() => computeNextRunAt(new Date(), '06:00', 'Not/AZone')).toThrow(AppError)
  })
})
