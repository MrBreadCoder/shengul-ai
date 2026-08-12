import { describe, it, expect, vi, beforeEach } from 'vitest'

const verifyQstashSignatureMock = vi.fn()
const generateReportMock = vi.fn()
const logErrorMock = vi.fn()

vi.mock('@/lib/qstash/verify', () => ({ verifyQstashSignature: (...a: unknown[]) => verifyQstashSignatureMock(...a) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/reports/generate', () => ({ generateReport: (...a: unknown[]) => generateReportMock(...a) }))
vi.mock('@/lib/events/log-event', () => ({ logError: (...a: unknown[]) => logErrorMock(...a) }))

import { POST } from './route'
import { AppError } from '@/lib/errors/app-error'

function req(body: unknown): Request {
  return new Request('http://x', { method: 'POST', body: JSON.stringify(body) })
}

beforeEach(() => {
  verifyQstashSignatureMock.mockReset().mockImplementation(async (request: Request) => request.text())
  generateReportMock.mockReset().mockResolvedValue({ id: 'r1', status: 'sent' })
  logErrorMock.mockReset().mockResolvedValue(undefined)
})

describe('POST /api/pipeline/reports-generate', () => {
  it('should return 401 when the QStash signature is invalid', async () => {
    verifyQstashSignatureMock.mockRejectedValue(new AppError('UNAUTHORIZED', 'bad signature'))
    const res = await POST(req({ clientId: '11111111-1111-4111-8111-111111111111', type: 'weekly' }))
    expect(res.status).toBe(401)
  })

  it('should call generateReport with the parsed body and return the result', async () => {
    const res = await POST(req({ clientId: '11111111-1111-4111-8111-111111111111', type: 'weekly' }))
    const json = await res.json()
    expect(generateReportMock).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ clientId: '11111111-1111-4111-8111-111111111111', type: 'weekly' }),
    )
    expect(json).toEqual({ ok: true, reportId: 'r1', status: 'sent' })
  })

  it('should return 404 when generateReport reports the client missing', async () => {
    generateReportMock.mockRejectedValue(new AppError('NOT_FOUND', 'Client not found'))
    const res = await POST(req({ clientId: '11111111-1111-4111-8111-111111111111', type: 'weekly' }))
    expect(res.status).toBe(404)
  })

  it('should return 500 and log the failure on an unexpected error', async () => {
    generateReportMock.mockRejectedValue(new Error('boom'))
    const res = await POST(req({ clientId: '11111111-1111-4111-8111-111111111111', type: 'weekly' }))
    expect(res.status).toBe(500)
    expect(logErrorMock).toHaveBeenCalled()
  })
})
