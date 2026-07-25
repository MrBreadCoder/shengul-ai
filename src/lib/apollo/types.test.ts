import { describe, it, expect } from 'vitest'
import { apolloIcpSchema } from './types'

describe('apolloIcpSchema', () => {
  it('should accept a valid employee range', () => {
    const result = apolloIcpSchema.safeParse({ employeeRangeMin: 10, employeeRangeMax: 100 })
    expect(result.success).toBe(true)
  })

  it('should accept an equal employee range', () => {
    const result = apolloIcpSchema.safeParse({ employeeRangeMin: 50, employeeRangeMax: 50 })
    expect(result.success).toBe(true)
  })

  it('should accept nullable employee range bounds', () => {
    const result = apolloIcpSchema.safeParse({ employeeRangeMin: null, employeeRangeMax: null })
    expect(result.success).toBe(true)
  })

  it('should accept a range with only one bound set', () => {
    const result = apolloIcpSchema.safeParse({ employeeRangeMin: 10, employeeRangeMax: null })
    expect(result.success).toBe(true)
  })

  it('should reject an inverted employee range where min exceeds max', () => {
    const result = apolloIcpSchema.safeParse({ employeeRangeMin: 100, employeeRangeMax: 10 })
    expect(result.success).toBe(false)
  })

  it('should default excludeOrganizationLocations and excludeKeywords to empty arrays', () => {
    const result = apolloIcpSchema.parse({})
    expect(result.excludeOrganizationLocations).toEqual([])
    expect(result.excludeKeywords).toEqual([])
  })
})
