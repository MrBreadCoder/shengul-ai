import { describe, it, expect } from 'vitest'
import { normalizeDomain, domainSchema } from './domain'

describe('normalizeDomain', () => {
  it('should strip protocol, www, path, and trailing dot', () => {
    expect(normalizeDomain('https://www.Acme.com/pricing?x=1')).toBe('acme.com')
  })

  it('should pass through an already-bare domain unchanged', () => {
    expect(normalizeDomain('acme.com')).toBe('acme.com')
  })

  it('should return an empty string for empty input', () => {
    expect(normalizeDomain('   ')).toBe('')
  })
})

describe('domainSchema', () => {
  it('should normalize a full URL into a bare domain', () => {
    expect(domainSchema.parse('https://www.acme.com/')).toBe('acme.com')
  })

  it('should transform empty input into null', () => {
    expect(domainSchema.parse('')).toBeNull()
  })

  it('should reject a value with no dot', () => {
    expect(() => domainSchema.parse('not-a-domain')).toThrow()
  })

  it('should reject a value with spaces', () => {
    expect(() => domainSchema.parse('acme corp.com')).toThrow()
  })
})
