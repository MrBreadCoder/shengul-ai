import { describe, it, expect, vi } from 'vitest'
import { withRetry } from './with-retry'
import { AppError } from '@/lib/errors/app-error'

const FAST = { baseDelayMs: 1, maxDelayMs: 2 }

describe('withRetry', () => {
  it('should return the result immediately when the call succeeds', async () => {
    const fn = vi.fn().mockResolvedValue('ok')
    const result = await withRetry(fn, FAST)
    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('should retry on a 429 AppError and eventually succeed', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new AppError('EXTERNAL_ERROR', 'HTTP 429', { status: 429 }))
      .mockRejectedValueOnce(new AppError('EXTERNAL_ERROR', 'HTTP 429', { status: 429 }))
      .mockResolvedValueOnce('ok')
    const result = await withRetry(fn, FAST)
    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('should retry on a 5xx AppError', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new AppError('EXTERNAL_ERROR', 'HTTP 503', { status: 503 }))
      .mockResolvedValueOnce('ok')
    const result = await withRetry(fn, FAST)
    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('should not retry a non-retryable status (e.g. 400)', async () => {
    const error = new AppError('EXTERNAL_ERROR', 'HTTP 400', { status: 400 })
    const fn = vi.fn().mockRejectedValue(error)
    await expect(withRetry(fn, FAST)).rejects.toBe(error)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('should not retry an error with no status (e.g. validation/timeout)', async () => {
    const error = new AppError('EXTERNAL_TIMEOUT', 'timed out', {})
    const fn = vi.fn().mockRejectedValue(error)
    await expect(withRetry(fn, FAST)).rejects.toBe(error)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('should give up after maxAttempts and rethrow the last error', async () => {
    const error = new AppError('EXTERNAL_ERROR', 'HTTP 429', { status: 429 })
    const fn = vi.fn().mockRejectedValue(error)
    await expect(withRetry(fn, { ...FAST, maxAttempts: 3 })).rejects.toBe(error)
    expect(fn).toHaveBeenCalledTimes(3)
  })
})
