import { describe, it, expect, vi, beforeEach } from 'vitest'

const verifyQstashSignatureMock = vi.fn()
const listActiveClientsMock = vi.fn()
const publishJsonMock = vi.fn()
const logEventMock = vi.fn()

vi.mock('@/lib/qstash/verify', () => ({ verifyQstashSignature: (...a: unknown[]) => verifyQstashSignatureMock(...a) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/db/clients', () => ({ listActiveClients: (...a: unknown[]) => listActiveClientsMock(...a) }))
vi.mock('@/lib/qstash/client', () => ({ publishJson: (...a: unknown[]) => publishJsonMock(...a) }))
vi.mock('@/lib/events/log-event', () => ({ logEvent: (...a: unknown[]) => logEventMock(...a) }))

import { POST } from './route'

function req(): Request {
  return new Request('http://x', { method: 'POST' })
}

beforeEach(() => {
  verifyQstashSignatureMock.mockReset().mockResolvedValue('{}')
  listActiveClientsMock.mockReset().mockResolvedValue([{ id: 'c1', name: 'Acme' }])
  publishJsonMock.mockReset().mockResolvedValue('msg1')
  logEventMock.mockReset().mockResolvedValue(undefined)
})

describe('POST /api/pipeline/reports-monthly-fanout', () => {
  it('should publish a monthly report job for every active client', async () => {
    const res = await POST(req())
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(publishJsonMock).toHaveBeenCalledWith('/api/pipeline/reports-generate', { clientId: 'c1', type: 'monthly' })
    expect(json.firedClientIds).toEqual(['c1'])
  })
})
