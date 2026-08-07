import { describe, it, expect } from 'vitest'
import { timeOfDaySchema, timezoneSchema, isValidTimezone } from './schedule'

describe('timeOfDaySchema', () => {
  it('should accept a zero-padded 24-hour time', () => {
    expect(timeOfDaySchema.safeParse('06:00').success).toBe(true)
    expect(timeOfDaySchema.safeParse('23:59').success).toBe(true)
    expect(timeOfDaySchema.safeParse('00:00').success).toBe(true)
  })

  it('should reject an hour above 23', () => {
    expect(timeOfDaySchema.safeParse('24:00').success).toBe(false)
  })

  it('should reject a minute above 59', () => {
    expect(timeOfDaySchema.safeParse('06:60').success).toBe(false)
  })

  it('should reject a non-zero-padded hour', () => {
    expect(timeOfDaySchema.safeParse('9:00').success).toBe(false)
  })

  it('should reject a non-time string', () => {
    expect(timeOfDaySchema.safeParse('not-a-time').success).toBe(false)
  })
})

describe('isValidTimezone / timezoneSchema', () => {
  it('should accept a real IANA timezone name', () => {
    expect(isValidTimezone('America/New_York')).toBe(true)
    expect(timezoneSchema.safeParse('Europe/Istanbul').success).toBe(true)
  })

  it('should accept UTC', () => {
    expect(isValidTimezone('UTC')).toBe(true)
  })

  it('should reject an unrecognized timezone name', () => {
    expect(isValidTimezone('Not/AZone')).toBe(false)
    expect(timezoneSchema.safeParse('Not/AZone').success).toBe(false)
  })

  it('should reject an empty string', () => {
    expect(isValidTimezone('')).toBe(false)
  })
})
