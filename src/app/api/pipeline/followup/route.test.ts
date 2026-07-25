import { describe, it, expect, vi, beforeEach } from 'vitest'

const verifyMock = vi.fn()
const runFollowupMock = vi.fn()

vi.mock('@/lib/qstash/verify', () => ({ verifyQstashSignature: (...a: unknown[]) => verifyMock(...a) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/pipeline/followup', () => ({
  runFollowupStep: (...a: unknown[]) => runFollowupMock(...a),
  MAX_FOLLOWUP_STEP: 3,
}))
const getSequenceByIdMock = vi.fn()
const logErrorMock = vi.fn()
vi.mock('@/lib/db/sequences', () => ({ getSequenceById: (...a: unknown[]) => getSequenceByIdMock(...a) }))
vi.mock('@/lib/events/log-event', () => ({ logError: (...a: unknown[]) => logErrorMock(...a) }))

import { POST } from './route'

const SEQUENCE_ID = '11111111-1111-4111-8111-111111111111'

function req(body: unknown) {
  return new Request('http://x/api/pipeline/followup', { method: 'POST', body: JSON.stringify(body) })
}

beforeEach(() => {
  verifyMock.mockReset(); runFollowupMock.mockReset()
  getSequenceByIdMock.mockReset(); logErrorMock.mockReset()
})

describe('POST /api/pipeline/followup', () => {
  it('should run the follow-up step and return the summary', async () => {
    verifyMock.mockResolvedValue(JSON.stringify({ sequenceId: SEQUENCE_ID, step: 1 }))
    runFollowupMock.mockResolvedValue({ sequenceId: 's1', action: 'sent' })
    const res = await POST(req({}))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.summary.action).toBe('sent')
  })

  it('should return 401 on invalid signature', async () => {
    const { AppError } = await import('@/lib/errors/app-error')
    verifyMock.mockRejectedValue(new AppError('UNAUTHORIZED', 'bad'))
    const res = await POST(req({}))
    expect(res.status).toBe(401)
  })

  it('should return 400 when the step is out of range', async () => {
    verifyMock.mockResolvedValue(JSON.stringify({ sequenceId: SEQUENCE_ID, step: 9 }))
    const res = await POST(req({}))
    expect(res.status).toBe(400)
  })

  it('should return 400 instead of 500 when the verified body is not valid JSON', async () => {
    verifyMock.mockResolvedValue('not json{')
    const res = await POST(req({}))
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toBe('validation_error')
  })
})

describe('followup route error attribution', () => {
  it('should resolve the sequence client on the error path and log the failure', async () => {
    const { AppError } = await import('@/lib/errors/app-error')
    verifyMock.mockResolvedValue(JSON.stringify({ sequenceId: SEQUENCE_ID, step: 1 }))
    runFollowupMock.mockRejectedValue(new AppError('DB_ERROR', 'connection reset', {}))
    getSequenceByIdMock.mockResolvedValue({ id: SEQUENCE_ID, client_id: 'c1' })

    const res = await POST(req({}))

    expect(res.status).toBe(500)
    expect(logErrorMock.mock.calls[0]?.[0]).toMatchObject({
      clientId: 'c1',
      type: 'pipeline.followup.route_failed',
      source: 'pipeline',
      payload: { sequenceId: SEQUENCE_ID, step: 1 },
    })
  })

  it('should log with a null client when the sequence lookup also fails', async () => {
    const { AppError } = await import('@/lib/errors/app-error')
    verifyMock.mockResolvedValue(JSON.stringify({ sequenceId: SEQUENCE_ID, step: 1 }))
    runFollowupMock.mockRejectedValue(new AppError('DB_ERROR', 'connection reset', {}))
    getSequenceByIdMock.mockRejectedValue(new AppError('DB_ERROR', 'still down', {}))

    const res = await POST(req({}))

    expect(res.status).toBe(500)
    expect(logErrorMock.mock.calls[0]?.[0]).toMatchObject({ clientId: null })
  })
})
