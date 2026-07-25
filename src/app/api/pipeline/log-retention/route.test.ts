import { describe, it, expect, vi, beforeEach } from 'vitest'

const verifyMock = vi.fn()
const deleteExpiredEventsMock = vi.fn()
const logEventSafeMock = vi.fn().mockResolvedValue(undefined)

vi.mock('@/lib/qstash/verify', () => ({ verifyQstashSignature: (r: Request) => verifyMock(r) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/db/events', () => ({
  deleteExpiredEvents: (...args: unknown[]) => deleteExpiredEventsMock(...args),
}))
vi.mock('@/lib/events/log-event', () => ({
  logEventSafe: (input: unknown) => logEventSafeMock(input),
}))

import { POST } from './route'
import { AppError } from '@/lib/errors/app-error'

function request(): Request {
  return new Request('http://localhost/api/pipeline/log-retention', { method: 'POST', body: '{}' })
}

describe('POST /api/pipeline/log-retention', () => {
  beforeEach(() => {
    verifyMock.mockReset().mockResolvedValue('{}')
    deleteExpiredEventsMock.mockReset()
    logEventSafeMock.mockClear()
  })

  it('should return 401 when the QStash signature is invalid', async () => {
    verifyMock.mockRejectedValue(new AppError('UNAUTHORIZED', 'bad signature', {}))

    const response = await POST(request())

    expect(response.status).toBe(401)
    expect(deleteExpiredEventsMock).not.toHaveBeenCalled()
  })

  it('should purge expired rows and return the summary when the signature is valid', async () => {
    deleteExpiredEventsMock.mockResolvedValue({ infoDeleted: 120, problemDeleted: 4 })

    const response = await POST(request())

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      ok: true,
      summary: { infoDeleted: 120, problemDeleted: 4 },
    })
    expect(deleteExpiredEventsMock.mock.calls[0]?.[2]).toEqual({ infoDays: 30, problemDays: 90 })
  })

  it('should log a retention event after a successful purge', async () => {
    deleteExpiredEventsMock.mockResolvedValue({ infoDeleted: 1, problemDeleted: 0 })

    await POST(request())

    expect(logEventSafeMock.mock.calls[0]?.[0]).toMatchObject({
      clientId: null,
      type: 'logs.retention.completed',
      severity: 'info',
      source: 'db',
      payload: { infoDeleted: 1, problemDeleted: 0 },
    })
  })

  it('should return 500 when the purge fails', async () => {
    deleteExpiredEventsMock.mockRejectedValue(new AppError('DB_ERROR', 'boom', {}))

    const response = await POST(request())

    expect(response.status).toBe(500)
  })
})
