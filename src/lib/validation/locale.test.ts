import { describe, it, expect } from 'vitest'
import { localeSchema } from './locale'

describe('localeSchema', () => {
  it('should accept every supported locale', () => {
    expect(localeSchema.safeParse('en').success).toBe(true)
    expect(localeSchema.safeParse('tr').success).toBe(true)
  })

  it('should reject an unsupported locale string', () => {
    expect(localeSchema.safeParse('fr').success).toBe(false)
  })

  it('should reject a non-string value', () => {
    expect(localeSchema.safeParse(123).success).toBe(false)
    expect(localeSchema.safeParse(null).success).toBe(false)
  })

  it('should reject a missing value', () => {
    expect(localeSchema.safeParse(undefined).success).toBe(false)
  })
})
