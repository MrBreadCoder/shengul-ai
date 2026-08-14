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

  it('should default discoverTime and discoverTimezone to null when omitted', () => {
    const result = campaignSettingsSchema.parse(valid)
    expect(result.discoverTime).toBeNull()
    expect(result.discoverTimezone).toBeNull()
  })

  it('should accept a valid discoverTime and discoverTimezone', () => {
    const result = campaignSettingsSchema.parse({ ...valid, discoverTime: '08:30', discoverTimezone: 'Europe/Istanbul' })
    expect(result.discoverTime).toBe('08:30')
    expect(result.discoverTimezone).toBe('Europe/Istanbul')
  })

  it('should reject a malformed discoverTime', () => {
    const result = campaignSettingsSchema.safeParse({ ...valid, discoverTime: '8:30' })
    expect(result.success).toBe(false)
  })

  it('should reject an invalid discoverTimezone', () => {
    const result = campaignSettingsSchema.safeParse({ ...valid, discoverTimezone: 'Not/AZone' })
    expect(result.success).toBe(false)
  })

  it("should reject an employeeRangeMax above Apollo's signed 32-bit integer limit", () => {
    // Regression test — this exact value (10 billion) reached Apollo unvalidated
    // and was rejected with HTTP 422 in production before this bound existed.
    const result = campaignSettingsSchema.safeParse({ ...valid, employeeRangeMin: 40, employeeRangeMax: 10_000_000_000 })
    expect(result.success).toBe(false)
  })

  it('should accept employeeRangeMin with no employeeRangeMax (open-ended above)', () => {
    const result = campaignSettingsSchema.safeParse({ ...valid, employeeRangeMin: 40, employeeRangeMax: null })
    expect(result.success).toBe(true)
  })

  it('should default mailboxIds to an empty array when omitted', () => {
    const result = campaignSettingsSchema.parse(valid)
    expect(result.mailboxIds).toEqual([])
  })

  it('should accept a list of mailbox uuids', () => {
    const id = '11111111-1111-4111-8111-111111111111'
    const result = campaignSettingsSchema.parse({ ...valid, mailboxIds: [id] })
    expect(result.mailboxIds).toEqual([id])
  })

  it('should reject a non-uuid mailboxIds entry', () => {
    const result = campaignSettingsSchema.safeParse({ ...valid, mailboxIds: ['not-a-uuid'] })
    expect(result.success).toBe(false)
  })

  it('should default signatureName, signatureTitle, phone, and address to null when omitted', () => {
    const result = campaignSettingsSchema.parse(valid)
    expect(result.signatureName).toBeNull()
    expect(result.signatureTitle).toBeNull()
    expect(result.phone).toBeNull()
    expect(result.address).toBeNull()
  })

  it('should accept a full set of signature override fields', () => {
    const result = campaignSettingsSchema.parse({
      ...valid,
      signatureName: 'John Smith',
      signatureTitle: 'Sales Director',
      phone: '+1 555 123 4567',
      address: '123 Main St, Istanbul, Turkey',
    })
    expect(result.signatureName).toBe('John Smith')
    expect(result.signatureTitle).toBe('Sales Director')
    expect(result.phone).toBe('+1 555 123 4567')
    expect(result.address).toBe('123 Main St, Istanbul, Turkey')
  })

  it('should reject an invalid phone override', () => {
    const result = campaignSettingsSchema.safeParse({ ...valid, phone: 'call me maybe' })
    expect(result.success).toBe(false)
  })

  it('should reject an empty-string phone override rather than silently clearing it', () => {
    const result = campaignSettingsSchema.safeParse({ ...valid, phone: '' })
    expect(result.success).toBe(false)
  })

  it('should reject a signatureName over 120 characters', () => {
    const result = campaignSettingsSchema.safeParse({ ...valid, signatureName: 'x'.repeat(121) })
    expect(result.success).toBe(false)
  })

  it('should reject an address over 200 characters', () => {
    const result = campaignSettingsSchema.safeParse({ ...valid, address: 'x'.repeat(201) })
    expect(result.success).toBe(false)
  })

  it('should reject an empty-string signatureName rather than silently clearing it', () => {
    const result = campaignSettingsSchema.safeParse({ ...valid, signatureName: '' })
    expect(result.success).toBe(false)
  })

  it('should reject a whitespace-only signatureName', () => {
    const result = campaignSettingsSchema.safeParse({ ...valid, signatureName: '   ' })
    expect(result.success).toBe(false)
  })

  it('should reject an empty-string signatureTitle rather than silently clearing it', () => {
    const result = campaignSettingsSchema.safeParse({ ...valid, signatureTitle: '' })
    expect(result.success).toBe(false)
  })

  it('should reject a whitespace-only signatureTitle', () => {
    const result = campaignSettingsSchema.safeParse({ ...valid, signatureTitle: '   ' })
    expect(result.success).toBe(false)
  })

  it('should reject an empty-string address rather than silently clearing it', () => {
    const result = campaignSettingsSchema.safeParse({ ...valid, address: '' })
    expect(result.success).toBe(false)
  })

  it('should reject a whitespace-only address', () => {
    const result = campaignSettingsSchema.safeParse({ ...valid, address: '   ' })
    expect(result.success).toBe(false)
  })
})
