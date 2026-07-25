import { describe, it, expect } from 'vitest'
import { describeError } from './error-context'
import { AppError } from '@/lib/errors/app-error'

describe('describeError', () => {
  it('should use the AppError code and message when given an AppError', () => {
    const error = new AppError('RATE_LIMITED', 'Apollo rejected the request', { url: 'x' })

    const result = describeError(error)

    expect(result).toEqual({ code: 'RATE_LIMITED', message: 'Apollo rejected the request' })
  })

  it('should fall back to UNEXPECTED_ERROR when given a plain Error', () => {
    const result = describeError(new Error('socket hang up'))

    expect(result).toEqual({ code: 'UNEXPECTED_ERROR', message: 'socket hang up' })
  })

  it('should stringify the value when given a non-Error throw', () => {
    const result = describeError('boom')

    expect(result).toEqual({ code: 'UNEXPECTED_ERROR', message: 'boom' })
  })

  it('should truncate a message longer than the cap so one log row cannot bloat the table', () => {
    const result = describeError(new Error('x'.repeat(500)))

    expect(result.message).toHaveLength(300)
    expect(result.message.endsWith('…')).toBe(true)
  })

  it('should describe null without throwing', () => {
    const result = describeError(null)

    expect(result).toEqual({ code: 'UNEXPECTED_ERROR', message: 'null' })
  })
})
