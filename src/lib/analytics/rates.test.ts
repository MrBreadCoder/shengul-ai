import { describe, it, expect } from 'vitest'
import { rate, formatPercent, formatCount, formatDateTime } from './rates'

describe('rate', () => {
  it('should divide the numerator by the denominator', () => {
    expect(rate(3, 12)).toBe(0.25)
  })

  it('should return null when the denominator is zero', () => {
    expect(rate(5, 0)).toBeNull()
  })

  it('should return null when the denominator is negative', () => {
    expect(rate(5, -1)).toBeNull()
  })
})

describe('formatPercent', () => {
  it('should render one decimal place', () => {
    expect(formatPercent(0.1234)).toBe('12.3%')
  })

  it('should render an em dash when the rate is undefined', () => {
    expect(formatPercent(null)).toBe('—')
  })

  it('should render zero as 0.0%', () => {
    expect(formatPercent(0)).toBe('0.0%')
  })
})

describe('formatCount', () => {
  it('should group thousands', () => {
    expect(formatCount(12345)).toBe('12,345')
  })
})

describe('formatDateTime', () => {
  it('should render an ISO timestamp as a UTC date and time', () => {
    expect(formatDateTime('2026-07-21T13:45:00.000Z')).toBe('2026-07-21 13:45 UTC')
  })

  it('should render an em dash when the timestamp is null', () => {
    expect(formatDateTime(null)).toBe('—')
  })
})
