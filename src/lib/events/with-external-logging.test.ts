import { describe, it, expect, vi, beforeEach } from 'vitest'

const logErrorMock = vi.fn()
// The factory is hoisted above the const, so the spy must be dereferenced
// lazily inside a lambda rather than captured at factory-evaluation time.
vi.mock('./log-event', () => ({ logError: (...args: unknown[]) => logErrorMock(...args) }))

import { withExternalLogging } from './with-external-logging'
import { AppError } from '@/lib/errors/app-error'

const context = {
  clientId: 'c1',
  caseId: 'case9',
  actor: 'system',
  failureType: 'apollo.search.failed',
  payload: { campaignId: 'camp1' },
}

describe('withExternalLogging', () => {
  beforeEach(() => logErrorMock.mockReset().mockResolvedValue(undefined))

  it('should return the work result and log nothing when the call succeeds', async () => {
    const result = await withExternalLogging('apollo', context, async () => ({ people: 3 }))

    expect(result).toEqual({ people: 3 })
    expect(logErrorMock).not.toHaveBeenCalled()
  })

  it('should log an error attributed to the client when the call fails', async () => {
    const failure = new AppError('EXTERNAL_TIMEOUT', 'HTTP request failed', {})

    await expect(
      withExternalLogging('apollo', context, () => Promise.reject(failure)),
    ).rejects.toBe(failure)

    expect(logErrorMock).toHaveBeenCalledWith({
      clientId: 'c1',
      caseId: 'case9',
      actor: 'system',
      type: 'apollo.search.failed',
      source: 'apollo',
      error: failure,
      payload: { campaignId: 'camp1' },
    })
  })

  it('should rethrow the original error unchanged so callers still branch on its code', async () => {
    const failure = new AppError('RATE_LIMITED', 'slow down', {})

    const caught = await withExternalLogging('apollo', context, () => Promise.reject(failure)).catch(
      (error: unknown) => error,
    )

    expect(caught).toBe(failure)
  })

  it('should default caseId to null when the context omits it', async () => {
    await expect(
      withExternalLogging(
        'gemini',
        { clientId: 'c1', actor: 'system', failureType: 'llm.failed' },
        () => Promise.reject(new Error('boom')),
      ),
    ).rejects.toBeInstanceOf(Error)

    expect(logErrorMock.mock.calls[0]?.[0]).toMatchObject({ caseId: null, payload: undefined })
  })
})
