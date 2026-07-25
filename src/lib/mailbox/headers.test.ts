import { describe, it, expect } from 'vitest'
import { AppError } from '@/lib/errors/app-error'
import { assertNoHeaderInjection } from './headers'

describe('assertNoHeaderInjection', () => {
  it('should return the value unchanged when it has no line breaks', () => {
    expect(assertNoHeaderInjection('Hello there', 'subject')).toBe('Hello there')
  })

  it('should throw VALIDATION_ERROR when the value contains a line feed', () => {
    expect(() => assertNoHeaderInjection('a\nBcc: attacker@evil.com', 'subject')).toThrow(AppError)
  })

  it('should throw VALIDATION_ERROR when the value contains a carriage return', () => {
    try {
      assertNoHeaderInjection('a\rBcc: attacker@evil.com', 'to')
      expect.unreachable('expected assertNoHeaderInjection to throw')
    } catch (error) {
      expect(error).toBeInstanceOf(AppError)
      expect((error as AppError).code).toBe('VALIDATION_ERROR')
      expect((error as AppError).context).toMatchObject({ field: 'to' })
    }
  })
})
