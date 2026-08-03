import { describe, it, expect } from 'vitest'
import { effectiveDailyCap, getMailboxWarmthStatus, warmupInsertFields } from './warmup'
import { AppError } from '@/lib/errors/app-error'

const START = '2026-07-01T00:00:00.000Z'

function atDay(day: number): Date {
  return new Date(Date.parse(START) + day * 86_400_000)
}

const BASE = { startCap: 5, increment: 3, targetCap: 40, dailyCap: 40 }

describe('effectiveDailyCap', () => {
  it('should return the already-warm daily cap when the profile is none', () => {
    const cap = effectiveDailyCap({ profile: 'none', warmupStartedAt: START, ...BASE, now: atDay(0) })
    expect(cap).toBe(40)
  })

  it('should return the already-warm daily cap when warmup never started', () => {
    const cap = effectiveDailyCap({ profile: 'standard', warmupStartedAt: null, ...BASE, now: atDay(0) })
    expect(cap).toBe(40)
  })

  it('should step every day when the profile is standard', () => {
    const caps = [0, 1, 2, 3, 4, 5].map((day) =>
      effectiveDailyCap({ profile: 'standard', warmupStartedAt: START, ...BASE, targetCap: 1000, now: atDay(day) }),
    )
    expect(caps).toEqual([5, 8, 11, 14, 17, 20])
  })

  it('should hold each level for two days when the profile is slow', () => {
    const caps = [0, 1, 2, 3, 4, 5].map((day) =>
      effectiveDailyCap({ profile: 'slow', warmupStartedAt: START, ...BASE, targetCap: 1000, now: atDay(day) }),
    )
    expect(caps).toEqual([5, 5, 8, 8, 11, 11])
  })

  it('should return the already-warm cap once the ramp value reaches the target', () => {
    // start 5 + increment 3 * 2 steps = 11, target 11 -> boundary, ramp complete.
    const cap = effectiveDailyCap({
      profile: 'standard', warmupStartedAt: START, startCap: 5, increment: 3, targetCap: 11, dailyCap: 50, now: atDay(2),
    })
    expect(cap).toBe(50)
  })

  it('should stay on the already-warm cap long after the ramp completes', () => {
    const cap = effectiveDailyCap({
      profile: 'standard', warmupStartedAt: START, startCap: 5, increment: 3, targetCap: 11, dailyCap: 50, now: atDay(30),
    })
    expect(cap).toBe(50)
  })

  it('should resume ramping if the target cap is raised after completion', () => {
    const completedCap = effectiveDailyCap({
      profile: 'standard', warmupStartedAt: START, startCap: 5, increment: 3, targetCap: 11, dailyCap: 50, now: atDay(2),
    })
    expect(completedCap).toBe(50)
    const resumedCap = effectiveDailyCap({
      profile: 'standard', warmupStartedAt: START, startCap: 5, increment: 3, targetCap: 100, dailyCap: 50, now: atDay(2),
    })
    expect(resumedCap).toBe(11)
  })

  it('should use each mailbox own start cap and increment', () => {
    const gentle = effectiveDailyCap({
      profile: 'standard', warmupStartedAt: START, startCap: 2, increment: 1, targetCap: 1000, dailyCap: 999, now: atDay(3),
    })
    const aggressive = effectiveDailyCap({
      profile: 'standard', warmupStartedAt: START, startCap: 10, increment: 10, targetCap: 1000, dailyCap: 999, now: atDay(3),
    })
    expect(gentle).toBe(5)
    expect(aggressive).toBe(40)
  })

  it('should start at the configured start cap on a partial first day', () => {
    const now = new Date(Date.parse(START) + 23 * 3_600_000)
    const cap = effectiveDailyCap({ profile: 'standard', warmupStartedAt: START, ...BASE, targetCap: 1000, now })
    expect(cap).toBe(5)
  })

  it('should clamp to the start cap when the clock is behind the start date', () => {
    const cap = effectiveDailyCap({ profile: 'standard', warmupStartedAt: START, ...BASE, targetCap: 1000, now: atDay(-5) })
    expect(cap).toBe(5)
  })

  it('should throw INVARIANT_VIOLATION when the start timestamp is unparseable', () => {
    expect(() =>
      effectiveDailyCap({ profile: 'standard', warmupStartedAt: 'not-a-date', ...BASE, now: atDay(0) }),
    ).toThrow(AppError)
  })
})

describe('getMailboxWarmthStatus', () => {
  it('should report not_ramping for an already-warm profile', () => {
    const status = getMailboxWarmthStatus({ profile: 'none', warmupStartedAt: null, ...BASE, now: atDay(0) })
    expect(status).toEqual({ kind: 'not_ramping' })
  })

  it('should report not_ramping when warmup never started', () => {
    const status = getMailboxWarmthStatus({ profile: 'standard', warmupStartedAt: null, ...BASE, now: atDay(0) })
    expect(status).toEqual({ kind: 'not_ramping' })
  })

  it('should report ramping with the current cap and day number', () => {
    const status = getMailboxWarmthStatus({
      profile: 'standard', warmupStartedAt: START, startCap: 5, increment: 3, targetCap: 1000, dailyCap: 40, now: atDay(2),
    })
    expect(status).toEqual({ kind: 'ramping', currentCap: 11, dayNumber: 3 })
  })

  it('should report ramp_complete exactly at the target boundary', () => {
    const status = getMailboxWarmthStatus({
      profile: 'standard', warmupStartedAt: START, startCap: 5, increment: 3, targetCap: 11, dailyCap: 40, now: atDay(2),
    })
    expect(status).toEqual({ kind: 'ramp_complete' })
  })

  it('should report ramp_complete long after the ramp finished', () => {
    const status = getMailboxWarmthStatus({
      profile: 'standard', warmupStartedAt: START, startCap: 5, increment: 3, targetCap: 11, dailyCap: 40, now: atDay(30),
    })
    expect(status).toEqual({ kind: 'ramp_complete' })
  })

  it('should throw INVARIANT_VIOLATION when the start timestamp is unparseable', () => {
    expect(() =>
      getMailboxWarmthStatus({ profile: 'standard', warmupStartedAt: 'not-a-date', ...BASE, now: atDay(0) }),
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
