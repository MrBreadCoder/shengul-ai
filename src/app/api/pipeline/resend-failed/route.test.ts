import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AppError } from '@/lib/errors/app-error'

const verifyMock = vi.fn()
const sweepMock = vi.fn()
const logEventMock = vi.fn()

vi.mock('@/lib/qstash/verify', () => ({ verifyQstashSignature: (...a: unknown[]) => verifyMock(...a) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/pipeline/resend-failed', () => ({ sweepFailedFirstTouch: (...a: unknown[]) => sweepMock(...a) }))
vi.mock('@/lib/events/log-event', () => ({ logEvent: (...a: unknown[]) => logEventMock(...a) }))

import { POST } from './route'

function req() {
  return new Request('http://x/api/pipeline/resend-failed', { method: 'POST', body: '{}' })
}

beforeEach(() => {
  verifyMock.mockReset().mockResolvedValue('{}')
  sweepMock.mockReset()
  logEventMock.mockReset().mockResolvedValue(undefined)
})

describe('POST /api/pipeline/resend-failed', () => {
  it('should sweep with the fixed batch limit and summarize outcomes', async () => {
    sweepMock.mockResolvedValue([
      { emailId: 'e1', outcome: 'sent' },
      { emailId: 'e2', outcome: 'rate_limited' },
      { emailId: 'e3', outcome: 'sent' },
    ])

    const res = await POST(req())
    const json = await res.json()

    expect(sweepMock).toHaveBeenCalledWith(expect.anything(), 50)
    expect(json).toEqual({ ok: true, attempted: 3, counts: { sent: 2, rate_limited: 1 } })
  })

  it('should log a completion event without failing the request when logging errors', async () => {
    sweepMock.mockResolvedValue([])
    logEventMock.mockRejectedValue(new Error('log sink down'))

    const res = await POST(req())

    expect(res.status).toBe(200)
  })

  it('should return 401 without sweeping when the QStash signature is invalid', async () => {
    verifyMock.mockRejectedValue(new AppError('UNAUTHORIZED', 'bad signature', {}))

    const res = await POST(req())

    expect(res.status).toBe(401)
    expect(sweepMock).not.toHaveBeenCalled()
  })

  it('should return 500 when the sweep itself throws', async () => {
    sweepMock.mockRejectedValue(new Error('db down'))

    const res = await POST(req())

    expect(res.status).toBe(500)
  })
})
