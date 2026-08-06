import { describe, it, expect } from 'vitest'
import { campaignSettingsSchema } from './campaign-settings-schema'

describe('campaignSettingsSchema', () => {
  const valid = {
    name: 'Q3 launch',
    valueProp: 'We cut reconciliation time.',
  }

  it('should accept the minimum required fields and apply defaults', () => {
    const result = campaignSettingsSchema.parse(valid)
    expect(result.bookingLink).toBeNull()
    expect(result.dailyTarget).toBe(50)
    expect(result.personTitles).toEqual([])
    expect(result.contactEmailStatuses).toEqual([])
  })

  it('should reject a missing name', () => {
    const result = campaignSettingsSchema.safeParse({ valueProp: 'x' })
    expect(result.success).toBe(false)
  })

  it('should reject a missing valueProp', () => {
    const result = campaignSettingsSchema.safeParse({ name: 'x' })
    expect(result.success).toBe(false)
  })

  it('should reject a dailyTarget above 100', () => {
    const result = campaignSettingsSchema.safeParse({ ...valid, dailyTarget: 101 })
    expect(result.success).toBe(false)
  })

  it('should reject an invalid bookingLink URL', () => {
    const result = campaignSettingsSchema.safeParse({ ...valid, bookingLink: 'not-a-url' })
    expect(result.success).toBe(false)
  })

  it('should reject an unknown personSeniorities value', () => {
    const result = campaignSettingsSchema.safeParse({ ...valid, personSeniorities: ['ceo'] })
    expect(result.success).toBe(false)
  })
})
