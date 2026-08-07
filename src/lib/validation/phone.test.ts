import { describe, it, expect } from 'vitest'
import { phoneSchema } from './phone'

describe('phoneSchema', () => {
  it('should accept a plain international number', () => {
    expect(phoneSchema.parse('+1 555 123 4567')).toBe('+1 555 123 4567')
  })

  it('should accept a number with parens and hyphens', () => {
    expect(phoneSchema.parse('(505) 555-1234')).toBe('(505) 555-1234')
  })

  it('should trim surrounding whitespace', () => {
    expect(phoneSchema.parse('  +1 555 123 4567  ')).toBe('+1 555 123 4567')
  })

  it('should transform empty input into null', () => {
    expect(phoneSchema.parse('')).toBeNull()
  })

  it('should transform whitespace-only input into null', () => {
    expect(phoneSchema.parse('   ')).toBeNull()
  })

  it('should reject a value with fewer than 7 digits', () => {
    expect(() => phoneSchema.parse('123 456')).toThrow()
  })

  it('should reject a value containing letters', () => {
    expect(() => phoneSchema.parse('call me maybe')).toThrow()
  })
})
