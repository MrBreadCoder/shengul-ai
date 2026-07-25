import { describe, it, expect, vi, beforeEach } from 'vitest'

const verifyMock = vi.fn()
const runCollisionNoticeMock = vi.fn()
const logErrorMock = vi.fn()

vi.mock('@/lib/qstash/verify', () => ({ verifyQstashSignature: (...a: unknown[]) => verifyMock(...a) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/pipeline/collision-notify', () => ({
  runCollisionNotice: (...a: unknown[]) => runCollisionNoticeMock(...a),
}))
vi.mock('@/lib/events/log-event', () => ({ logError: (...a: unknown[]) => logErrorMock(...a) }))

import { POST } from './route'

function req(body: unknown) {
  return new Request('http://x/api/pipeline/collision-notify', { method: 'POST', body: JSON.stringify(body) })
}

const CASE_ID = '11111111-1111-4111-8111-111111111111'
const LEAD_ID = '22222222-2222-4222-8222-222222222222'
const TRIGGERING_LEAD_ID = '33333333-3333-4333-8333-333333333333'
const payload = { caseId: CASE_ID, leadId: LEAD_ID, triggeringLeadId: TRIGGERING_LEAD_ID }

beforeEach(() => {
  for (const m of [verifyMock, runCollisionNoticeMock, logErrorMock]) m.mockReset()
  verifyMock.mockResolvedValue(JSON.stringify(payload))
})

describe('POST /api/pipeline/collision-notify', () => {
  it('should run the collision notice worker with the parsed payload', async () => {
    runCollisionNoticeMock.mockResolvedValue({ leadId: LEAD_ID, action: 'notified' })
    const res = await POST(req(payload))
    expect(res.status).toBe(200)
    expect(runCollisionNoticeMock).toHaveBeenCalledWith({}, payload)
  })

  it('should return 401 on invalid QStash signature', async () => {
    const { AppError } = await import('@/lib/errors/app-error')
    verifyMock.mockRejectedValue(new AppError('UNAUTHORIZED', 'bad signature'))
    const res = await POST(req(payload))
    expect(res.status).toBe(401)
  })

  it('should return 400 on a malformed body', async () => {
    verifyMock.mockResolvedValue(JSON.stringify({ caseId: CASE_ID }))
    const res = await POST(req({ caseId: CASE_ID }))
    expect(res.status).toBe(400)
  })

  it('should return 400 on unparseable JSON', async () => {
    verifyMock.mockResolvedValue('not json')
    const res = await POST(req(payload))
    expect(res.status).toBe(400)
  })

  it('should log and return 500 when the worker throws', async () => {
    runCollisionNoticeMock.mockRejectedValue(new Error('boom'))
    const res = await POST(req(payload))
    expect(res.status).toBe(500)
    expect(logErrorMock).toHaveBeenCalled()
  })
})
