import { describe, it, expect, vi, beforeEach } from 'vitest'

const publishJsonWithDelayMock = vi.fn()
const logErrorMock = vi.fn()
const logWarnMock = vi.fn()

vi.mock('@/lib/qstash/client', () => ({
  publishJsonWithDelay: (...a: unknown[]) => publishJsonWithDelayMock(...a),
}))
vi.mock('@/lib/events/log-event', () => ({
  logError: (...a: unknown[]) => logErrorMock(...a),
  logWarn: (...a: unknown[]) => logWarnMock(...a),
}))

import { handleModelOverload, OVERLOAD_RETRY_DELAY_SECONDS, MAX_OVERLOAD_RETRIES } from './overload-retry'

const baseInput = {
  path: '/api/pipeline/research',
  caseId: 'case1',
  clientId: 'client1',
  actor: 'system',
  eventPrefix: 'pipeline.research',
  error: new Error('503 overloaded'),
}

beforeEach(() => {
  publishJsonWithDelayMock.mockReset().mockResolvedValue('msg1')
  logErrorMock.mockReset()
  logWarnMock.mockReset()
})

describe('handleModelOverload', () => {
  it('should revert the claim and schedule a delayed retry when under the cap', async () => {
    const revert = vi.fn().mockResolvedValue(undefined)
    const outcome = await handleModelOverload({ ...baseInput, retryCount: 0, revert })

    expect(revert).toHaveBeenCalledTimes(1)
    expect(publishJsonWithDelayMock).toHaveBeenCalledWith(
      '/api/pipeline/research',
      { caseId: 'case1', retryCount: 1 },
      OVERLOAD_RETRY_DELAY_SECONDS,
    )
    expect(outcome).toEqual({ scheduled: true, nextRetryCount: 1 })
    expect(logWarnMock).toHaveBeenCalledWith(expect.objectContaining({
      clientId: 'client1', caseId: 'case1', type: 'pipeline.research.overload_retry_scheduled',
    }))
  })

  it('should increment retryCount on each successive call', async () => {
    const revert = vi.fn().mockResolvedValue(undefined)
    const outcome = await handleModelOverload({ ...baseInput, retryCount: 2, revert })

    expect(publishJsonWithDelayMock).toHaveBeenCalledWith(
      '/api/pipeline/research',
      { caseId: 'case1', retryCount: 3 },
      OVERLOAD_RETRY_DELAY_SECONDS,
    )
    expect(outcome).toEqual({ scheduled: true, nextRetryCount: 3 })
  })

  it('should give up and log an error once the cap is reached, without scheduling a retry', async () => {
    const revert = vi.fn().mockResolvedValue(undefined)
    const outcome = await handleModelOverload({ ...baseInput, retryCount: MAX_OVERLOAD_RETRIES, revert })

    expect(revert).toHaveBeenCalledTimes(1)
    expect(publishJsonWithDelayMock).not.toHaveBeenCalled()
    expect(outcome).toEqual({ scheduled: false })
    expect(logErrorMock).toHaveBeenCalledWith(expect.objectContaining({
      clientId: 'client1', caseId: 'case1', type: 'pipeline.research.overload_exhausted',
    }))
  })

  it('should still attempt the retry and log a warning when revert itself fails', async () => {
    const revert = vi.fn().mockRejectedValue(new Error('db down'))
    const outcome = await handleModelOverload({ ...baseInput, retryCount: 0, revert })

    expect(logWarnMock).toHaveBeenCalledWith(expect.objectContaining({
      type: 'pipeline.research.overload_revert_failed',
    }))
    expect(publishJsonWithDelayMock).toHaveBeenCalled()
    expect(outcome).toEqual({ scheduled: true, nextRetryCount: 1 })
  })

  it('should return scheduled: false and log an error when scheduling the retry itself fails', async () => {
    const revert = vi.fn().mockResolvedValue(undefined)
    publishJsonWithDelayMock.mockRejectedValue(new Error('qstash down'))

    const outcome = await handleModelOverload({ ...baseInput, retryCount: 0, revert })

    expect(outcome).toEqual({ scheduled: false })
    expect(logErrorMock).toHaveBeenCalledWith(expect.objectContaining({
      type: 'pipeline.research.overload_retry_schedule_failed',
    }))
  })

  it('should never throw even when both revert and scheduling fail', async () => {
    const revert = vi.fn().mockRejectedValue(new Error('db down'))
    publishJsonWithDelayMock.mockRejectedValue(new Error('qstash down'))

    await expect(handleModelOverload({ ...baseInput, retryCount: 0, revert })).resolves.toEqual({ scheduled: false })
  })
})
