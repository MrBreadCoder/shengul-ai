import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AppError } from '@/lib/errors/app-error'

const publishJSONMock = vi.fn()
const scheduleCreateMock = vi.fn()

vi.mock('@upstash/qstash', () => ({
  Client: class {
    publishJSON(...args: unknown[]) {
      return publishJSONMock(...args)
    }
    schedules = { create: (...args: unknown[]) => scheduleCreateMock(...args) }
  },
}))
vi.mock('@/lib/env', () => ({ env: { QSTASH_TOKEN: 'qs-token', APP_URL: 'https://app.example.com' } }))

import { publishJson, scheduleCron, publishJsonWithDelay } from './client'

beforeEach(() => {
  publishJSONMock.mockReset()
  scheduleCreateMock.mockReset()
})

describe('publishJson', () => {
  it('should return the message id when publish succeeds', async () => {
    publishJSONMock.mockResolvedValue({ messageId: 'msg1' })
    const result = await publishJson('/api/pipeline/research', { caseId: 'case1' })
    expect(result).toBe('msg1')
  })

  it('should throw EXTERNAL_ERROR when publish rejects', async () => {
    publishJSONMock.mockRejectedValue(new Error('down'))
    await expect(publishJson('/api/x', {})).rejects.toBeInstanceOf(AppError)
  })
})

describe('scheduleCron', () => {
  it('should return the schedule id when create succeeds', async () => {
    scheduleCreateMock.mockResolvedValue({ scheduleId: 'sched1' })
    const result = await scheduleCron('/api/pipeline/discover-fanout', '0 7 * * *')
    expect(result).toBe('sched1')
  })

  it('should throw EXTERNAL_ERROR when create rejects', async () => {
    scheduleCreateMock.mockRejectedValue(new Error('down'))
    await expect(scheduleCron('/api/x', '* * * * *')).rejects.toBeInstanceOf(AppError)
  })
})

describe('publishJsonWithDelay', () => {
  it('should pass the delay through and return the message id', async () => {
    publishJSONMock.mockResolvedValue({ messageId: 'msg2' })
    const result = await publishJsonWithDelay('/api/pipeline/followup', { sequenceId: 'seq1', step: 1 }, 259_200)
    expect(result).toBe('msg2')
    expect(publishJSONMock).toHaveBeenCalledWith(
      expect.objectContaining({ delay: 259_200 }),
    )
  })

  it('should throw EXTERNAL_ERROR when publish rejects', async () => {
    publishJSONMock.mockRejectedValue(new Error('down'))
    await expect(publishJsonWithDelay('/api/x', {}, 60)).rejects.toBeInstanceOf(AppError)
  })
})
