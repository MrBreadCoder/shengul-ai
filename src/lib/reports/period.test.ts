import { describe, it, expect } from 'vitest'
import { getWeeklyPeriod, getMonthlyPeriod } from './period'

describe('getWeeklyPeriod', () => {
  it('should return a 7-day UTC-day-aligned window ending at the start of today', () => {
    const now = new Date('2026-08-11T14:32:00.000Z')
    const period = getWeeklyPeriod(now)
    expect(period.periodStart).toBe('2026-08-04T00:00:00.000Z')
    expect(period.periodEnd).toBe('2026-08-11T00:00:00.000Z')
    expect(period.periodLabel).toBe('this week')
  })

  it('should truncate a mid-day timestamp to the UTC day boundary', () => {
    const now = new Date('2026-08-11T23:59:59.000Z')
    const period = getWeeklyPeriod(now)
    expect(period.periodEnd).toBe('2026-08-11T00:00:00.000Z')
  })
})

describe('getMonthlyPeriod', () => {
  it('should cover the previous calendar month in full', () => {
    const now = new Date('2026-08-01T08:00:00.000Z')
    const period = getMonthlyPeriod(now)
    expect(period.periodStart).toBe('2026-07-01T00:00:00.000Z')
    expect(period.periodEnd).toBe('2026-08-01T00:00:00.000Z')
    expect(period.periodLabel).toBe('this month')
  })

  it('should wrap January back to the previous December', () => {
    const now = new Date('2026-01-01T08:00:00.000Z')
    const period = getMonthlyPeriod(now)
    expect(period.periodStart).toBe('2025-12-01T00:00:00.000Z')
    expect(period.periodEnd).toBe('2026-01-01T00:00:00.000Z')
  })

  it('should handle a 31-day previous month correctly', () => {
    const now = new Date('2026-09-01T08:00:00.000Z')
    const period = getMonthlyPeriod(now)
    expect(period.periodStart).toBe('2026-08-01T00:00:00.000Z')
    expect(period.periodEnd).toBe('2026-09-01T00:00:00.000Z')
  })

  it('should handle a leap-year February as the previous month', () => {
    const now = new Date('2028-03-01T08:00:00.000Z')
    const period = getMonthlyPeriod(now)
    expect(period.periodStart).toBe('2028-02-01T00:00:00.000Z')
    expect(period.periodEnd).toBe('2028-03-01T00:00:00.000Z')
  })
})
