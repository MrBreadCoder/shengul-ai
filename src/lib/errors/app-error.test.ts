import { describe, it, expect } from 'vitest'
import { AppError, isAppError } from './app-error'

describe('AppError', () => {
  it('should carry code, message, and context when constructed', () => {
    const err = new AppError('VALIDATION_ERROR', 'bad input', { field: 'email' })
    expect(err.code).toBe('VALIDATION_ERROR')
    expect(err.message).toBe('bad input')
    expect(err.context).toEqual({ field: 'email' })
    expect(err.name).toBe('AppError')
    expect(err).toBeInstanceOf(Error)
  })

  it('should default context to an empty object when omitted', () => {
    const err = new AppError('NOT_FOUND', 'missing')
    expect(err.context).toEqual({})
  })

  it('should identify AppError instances when isAppError is called', () => {
    expect(isAppError(new AppError('UNAUTHORIZED', 'no'))).toBe(true)
    expect(isAppError(new Error('plain'))).toBe(false)
    expect(isAppError('string')).toBe(false)
  })
})
