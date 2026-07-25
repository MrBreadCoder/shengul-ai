import { describe, expect, it } from 'vitest'
import { formatLegalDate } from '@/lib/legal/format-date'

describe('formatLegalDate', () => {
  it('should render an ISO date as long-form prose', () => {
    expect(formatLegalDate('2026-07-25')).toBe('25 July 2026')
  })

  it('should drop the leading zero from a single-digit day', () => {
    expect(formatLegalDate('2026-01-05')).toBe('5 January 2026')
  })

  it('should render December without falling off the end of the month table', () => {
    expect(formatLegalDate('2025-12-31')).toBe('31 December 2025')
  })

  it('should return the input unchanged when it is not an ISO date', () => {
    expect(formatLegalDate('June 29, 2025')).toBe('June 29, 2025')
  })

  it('should return the input unchanged when the month is out of range', () => {
    expect(formatLegalDate('2026-13-01')).toBe('2026-13-01')
  })
})
