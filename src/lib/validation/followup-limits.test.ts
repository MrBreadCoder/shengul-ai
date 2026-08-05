import { describe, it, expect } from 'vitest'
import { followupDelaysSchema, MIN_FOLLOWUP_STEPS, MAX_FOLLOWUP_STEPS, MAX_FOLLOWUP_DELAY_DAYS } from './followup-limits'

describe('followupDelaysSchema', () => {
  it('should accept the default 3/7/14 cadence', () => {
    const result = followupDelaysSchema.safeParse([3, 7, 14])
    expect(result.success).toBe(true)
  })

  it('should coerce string form-data values to numbers', () => {
    const result = followupDelaysSchema.safeParse(['3', '7', '14'])
    expect(result).toMatchObject({ success: true, data: [3, 7, 14] })
  })

  it('should reject an empty array (below the step floor)', () => {
    const result = followupDelaysSchema.safeParse([])
    expect(result.success).toBe(false)
  })

  it('should reject more than MAX_FOLLOWUP_STEPS entries', () => {
    const result = followupDelaysSchema.safeParse(Array.from({ length: MAX_FOLLOWUP_STEPS + 1 }, () => 3))
    expect(result.success).toBe(false)
  })

  it('should accept exactly MIN_FOLLOWUP_STEPS entries', () => {
    const result = followupDelaysSchema.safeParse(Array.from({ length: MIN_FOLLOWUP_STEPS }, () => 5))
    expect(result.success).toBe(true)
  })

  it('should reject a day value below 1', () => {
    const result = followupDelaysSchema.safeParse([0])
    expect(result.success).toBe(false)
  })

  it('should reject a day value above MAX_FOLLOWUP_DELAY_DAYS', () => {
    const result = followupDelaysSchema.safeParse([MAX_FOLLOWUP_DELAY_DAYS + 1])
    expect(result.success).toBe(false)
  })

  it('should reject a non-integer day value', () => {
    const result = followupDelaysSchema.safeParse([3.5])
    expect(result.success).toBe(false)
  })

  it('should not require ascending order', () => {
    const result = followupDelaysSchema.safeParse([14, 3, 7])
    expect(result.success).toBe(true)
  })
})
