import { describe, it, expect } from 'vitest'
import { effectiveDailyCap, warmupInsertFields, WARMUP_START_CAP } from './warmup'
import { AppError } from '@/lib/errors/app-error'

const START = '2026-07-01T00:00:00.000Z'

function atDay(day: number): Date {
  return new Date(Date.parse(START) + day * 86_400_000)
}

describe('effectiveDailyCap', () => {
  it('should return the configured cap when the profile is none', () => {
    const cap = effectiveDailyCap({ profile: 'none', warmupStartedAt: START, dailyCap: 40, now: atDay(0) })
    expect(cap).toBe(40)
  })

  it('should return the configured cap when warmup never started', () => {
    const cap = effectiveDailyCap({ profile: 'standard', warmupStartedAt: null, dailyCap: 40, now: atDay(0) })
    expect(cap).toBe(40)
  })

  it('should step every day when the profile is standard', () => {
    const caps = [0, 1, 2, 3, 4, 5].map((day) =>
      effectiveDailyCap({ profile: 'standard', warmupStartedAt: START, dailyCap: 40, now: atDay(day) }),
    )
    expect(caps).toEqual([5, 8, 11, 14, 17, 20])
  })

  it('should hold each level for two days when the profile is slow', () => {
    const caps = [0, 1, 2, 3, 4, 5].map((day) =>
      effectiveDailyCap({ profile: 'slow', warmupStartedAt: START, dailyCap: 40, now: atDay(day) }),
    )
    expect(caps).toEqual([5, 5, 8, 8, 11, 11])
  })

  it('should never exceed the configured daily cap', () => {
    const cap = effectiveDailyCap({ profile: 'standard', warmupStartedAt: START, dailyCap: 12, now: atDay(30) })
    expect(cap).toBe(12)
  })

  it('should start at WARMUP_START_CAP on a partial first day', () => {
    const now = new Date(Date.parse(START) + 23 * 3_600_000)
    const cap = effectiveDailyCap({ profile: 'standard', warmupStartedAt: START, dailyCap: 40, now })
    expect(cap).toBe(WARMUP_START_CAP)
  })

  it('should clamp to the start cap when the clock is behind the start date', () => {
    const cap = effectiveDailyCap({ profile: 'standard', warmupStartedAt: START, dailyCap: 40, now: atDay(-5) })
    expect(cap).toBe(WARMUP_START_CAP)
  })

  it('should throw INVARIANT_VIOLATION when the start timestamp is unparseable', () => {
    expect(() =>
      effectiveDailyCap({ profile: 'standard', warmupStartedAt: 'not-a-date', dailyCap: 40, now: atDay(0) }),
    ).toThrow(AppError)
  })
})

describe('warmupInsertFields', () => {
  it('should stamp a start time for a ramping profile', () => {
    const fields = warmupInsertFields('standard', atDay(0))
    expect(fields).toEqual({ warmup_profile: 'standard', warmup_started_at: START })
  })

  it('should leave the start time null for an already-warm mailbox', () => {
    const fields = warmupInsertFields('none', atDay(0))
    expect(fields).toEqual({ warmup_profile: 'none', warmup_started_at: null })
  })
})
