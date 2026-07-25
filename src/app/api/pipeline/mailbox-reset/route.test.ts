import { describe, it, expect, vi, beforeEach } from 'vitest'

const verifyMock = vi.fn()
const resetMock = vi.fn()

vi.mock('@/lib/qstash/verify', () => ({ verifyQstashSignature: (...a: unknown[]) => verifyMock(...a) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/db/mailboxes', () => ({ resetDailyCounters: (...a: unknown[]) => resetMock(...a) }))
vi.mock('@/lib/events/log-event', () => ({ logEvent: vi.fn() }))

import { POST } from './route'

beforeEach(() => { verifyMock.mockReset(); resetMock.mockReset() })

describe('POST /api/pipeline/mailbox-reset', () => {
  it('should reset counters and return ok', async () => {
    verifyMock.mockResolvedValue('{}')
    const res = await POST(new Request('http://x', { method: 'POST', body: '{}' }))
    expect(res.status).toBe(200)
    expect(resetMock).toHaveBeenCalled()
  })

  it('should return 401 on invalid signature', async () => {
    const { AppError } = await import('@/lib/errors/app-error')
    verifyMock.mockRejectedValue(new AppError('UNAUTHORIZED', 'bad'))
    const res = await POST(new Request('http://x', { method: 'POST', body: '{}' }))
    expect(res.status).toBe(401)
  })
})
