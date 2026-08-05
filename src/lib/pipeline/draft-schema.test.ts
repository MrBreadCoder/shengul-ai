import { describe, it, expect } from 'vitest'
import { draftSchema, SUBJECT_HARD_LIMIT } from './draft-schema'

describe('draftSchema', () => {
  it('should accept a valid subject and body', () => {
    const result = draftSchema.safeParse({ subject: 'Quick idea for Acme', body: 'Hi Jane, saw you just...' })
    expect(result.success).toBe(true)
  })

  it('should reject an empty subject', () => {
    const result = draftSchema.safeParse({ subject: '', body: 'Hi Jane...' })
    expect(result.success).toBe(false)
  })

  it('should reject a subject over the hard limit', () => {
    const result = draftSchema.safeParse({ subject: 'x'.repeat(SUBJECT_HARD_LIMIT + 1), body: 'Hi Jane...' })
    expect(result.success).toBe(false)
  })

  it('should reject an empty body', () => {
    const result = draftSchema.safeParse({ subject: 'Quick idea', body: '' })
    expect(result.success).toBe(false)
  })

  it('should reject a payload missing the body field', () => {
    const result = draftSchema.safeParse({ subject: 'Quick idea' })
    expect(result.success).toBe(false)
  })

  it('should reject a non-string subject', () => {
    const result = draftSchema.safeParse({ subject: 123, body: 'Hi Jane...' })
    expect(result.success).toBe(false)
  })
})
