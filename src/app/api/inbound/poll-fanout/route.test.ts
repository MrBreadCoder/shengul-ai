import { describe, it, expect, vi, beforeEach } from 'vitest'

const verifyMock = vi.fn()
const listAllMailboxesMock = vi.fn()
const publishJsonMock = vi.fn()
const logEventMock = vi.fn()

vi.mock('@/lib/qstash/verify', () => ({ verifyQstashSignature: (...a: unknown[]) => verifyMock(...a) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/db/mailboxes', () => ({ listAllMailboxes: (...a: unknown[]) => listAllMailboxesMock(...a) }))
vi.mock('@/lib/qstash/client', () => ({ publishJson: (...a: unknown[]) => publishJsonMock(...a) }))
vi.mock('@/lib/events/log-event', () => ({ logEvent: (...a: unknown[]) => logEventMock(...a) }))

import { POST } from './route'

function req() { return new Request('http://x/api/inbound/poll-fanout', { method: 'POST' }) }

beforeEach(() => {
  for (const m of [verifyMock, listAllMailboxesMock, publishJsonMock, logEventMock]) m.mockReset()
})

describe('POST /api/inbound/poll-fanout', () => {
  it('should publish one poll message per mailbox', async () => {
    verifyMock.mockResolvedValue('{}')
    listAllMailboxesMock.mockResolvedValue([{ id: 'm1' }, { id: 'm2' }])
    const res = await POST(req())
    expect(res.status).toBe(200)
    expect(publishJsonMock).toHaveBeenCalledTimes(2)
    expect(publishJsonMock).toHaveBeenCalledWith('/api/inbound/poll', { mailboxId: 'm1' })
  })

  it('should return 401 on invalid signature', async () => {
    const { AppError } = await import('@/lib/errors/app-error')
    verifyMock.mockRejectedValue(new AppError('UNAUTHORIZED', 'bad'))
    const res = await POST(req())
    expect(res.status).toBe(401)
  })
})
