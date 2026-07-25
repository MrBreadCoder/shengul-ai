import { describe, it, expect } from 'vitest'
import {
  parseRangeDays,
  rangeFromDays,
  analyticsSearchParamsSchema,
  DEFAULT_RANGE_DAYS,
} from './range'

describe('parseRangeDays', () => {
  it('should return the value when it is a supported range', () => {
    expect(parseRangeDays(7)).toBe(7)
    expect(parseRangeDays(90)).toBe(90)
  })

  it('should fall back to the default when the value is unsupported', () => {
    expect(parseRangeDays(13)).toBe(DEFAULT_RANGE_DAYS)
  })

  it('should fall back to the default when the value is undefined', () => {
    expect(parseRangeDays(undefined)).toBe(DEFAULT_RANGE_DAYS)
  })
})

describe('rangeFromDays', () => {
  it('should end at the start of the next UTC day so today is included', () => {
    const now = new Date('2026-07-21T13:45:00.000Z')
    expect(rangeFromDays(7, now).to).toBe('2026-07-22T00:00:00.000Z')
  })

  it('should start N days before the end boundary', () => {
    const now = new Date('2026-07-21T13:45:00.000Z')
    expect(rangeFromDays(7, now).from).toBe('2026-07-15T00:00:00.000Z')
  })

  it('should span 30 UTC days for the 30-day range', () => {
    const now = new Date('2026-01-05T00:00:01.000Z')
    const { from, to } = rangeFromDays(30, now)
    const spanDays = (Date.parse(to) - Date.parse(from)) / 86_400_000
    expect(spanDays).toBe(30)
  })
})

describe('analyticsSearchParamsSchema', () => {
  it('should coerce a numeric days string', () => {
    const parsed = analyticsSearchParamsSchema.safeParse({ days: '30' })
    expect(parsed.success && parsed.data.days).toBe(30)
  })

  it('should accept a uuid campaign filter', () => {
    const id = '11111111-1111-4111-8111-111111111111'
    const parsed = analyticsSearchParamsSchema.safeParse({ campaign: id })
    expect(parsed.success && parsed.data.campaign).toBe(id)
  })

  it('should reject a non-uuid campaign filter', () => {
    expect(analyticsSearchParamsSchema.safeParse({ campaign: 'nope' }).success).toBe(false)
  })

  it('should accept an empty object', () => {
    const parsed = analyticsSearchParamsSchema.safeParse({})
    expect(parsed.success && parsed.data.days).toBeUndefined()
  })

  it('should accept a uuid client filter', () => {
    const id = '22222222-2222-4222-8222-222222222222'
    const parsed = analyticsSearchParamsSchema.safeParse({ client: id })
    expect(parsed.success && parsed.data.client).toBe(id)
  })

  it('should reject a non-uuid client filter', () => {
    expect(analyticsSearchParamsSchema.safeParse({ client: 'nope' }).success).toBe(false)
  })
})
