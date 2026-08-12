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
import { AppError } from '@/lib/errors/app-error'

function req(): Request {
  return new Request('http://x', { method: 'POST' })
}

beforeEach(() => {
  verifyQstashSignatureMock.mockReset().mockResolvedValue('{}')
  listActiveClientsMock.mockReset().mockResolvedValue([])
  publishJsonMock.mockReset().mockResolvedValue('msg1')
  logEventMock.mockReset().mockResolvedValue(undefined)
})

describe('POST /api/pipeline/reports-weekly-fanout', () => {
  it('should return 401 when the QStash signature is invalid', async () => {
    verifyQstashSignatureMock.mockRejectedValue(new AppError('UNAUTHORIZED', 'bad signature'))
    const res = await POST(req())
    expect(res.status).toBe(401)
    expect(listActiveClientsMock).not.toHaveBeenCalled()
  })

  it('should publish a weekly report job for every active client', async () => {
    listActiveClientsMock.mockResolvedValue([{ id: 'c1', name: 'Acme' }, { id: 'c2', name: 'Beta' }])
    const res = await POST(req())
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(publishJsonMock).toHaveBeenCalledWith('/api/pipeline/reports-generate', { clientId: 'c1', type: 'weekly' })
    expect(publishJsonMock).toHaveBeenCalledWith('/api/pipeline/reports-generate', { clientId: 'c2', type: 'weekly' })
    expect(json.firedClientIds).toEqual(['c1', 'c2'])
  })

  it('should isolate a publish failure without stopping the rest', async () => {
    listActiveClientsMock.mockResolvedValue([{ id: 'c1', name: 'Acme' }, { id: 'c2', name: 'Beta' }])
    publishJsonMock.mockImplementation((path: string, body: { clientId: string }) =>
      body.clientId === 'c2' ? Promise.reject(new Error('qstash down')) : Promise.resolve('msg1'),
    )
    const res = await POST(req())
    const json = await res.json()
    expect(json.firedClientIds).toEqual(['c1'])
    expect(json.failedClientIds).toEqual(['c2'])
  })
})
