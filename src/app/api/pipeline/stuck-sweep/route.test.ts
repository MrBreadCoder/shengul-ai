import { describe, it, expect, vi, beforeEach } from 'vitest'

const verifyMock = vi.fn()
const listStuckCasesMock = vi.fn()
const updateCaseStatusMock = vi.fn()
const publishJsonMock = vi.fn()
const logEventSafeMock = vi.fn()

vi.mock('@/lib/qstash/verify', () => ({ verifyQstashSignature: (...a: unknown[]) => verifyMock(...a) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/db/cases', () => ({
  listStuckCases: (...a: unknown[]) => listStuckCasesMock(...a),
  updateCaseStatus: (...a: unknown[]) => updateCaseStatusMock(...a),
}))
vi.mock('@/lib/qstash/client', () => ({ publishJson: (...a: unknown[]) => publishJsonMock(...a) }))
vi.mock('@/lib/events/log-event', () => ({ logEventSafe: (...a: unknown[]) => logEventSafeMock(...a) }))

import { POST } from './route'

function req() {
  return new Request('http://x', { method: 'POST', body: '{}' })
}

beforeEach(() => {
  for (const m of [verifyMock, listStuckCasesMock, updateCaseStatusMock, publishJsonMock, logEventSafeMock]) m.mockReset()
  verifyMock.mockResolvedValue('{}')
  updateCaseStatusMock.mockResolvedValue(undefined)
  publishJsonMock.mockResolvedValue('msg1')
})

describe('POST /api/pipeline/stuck-sweep', () => {
  it('should reset a researching case to new and re-queue it to research', async () => {
    listStuckCasesMock.mockResolvedValue([{ id: 'case1', status: 'researching' }])

    const res = await POST(req())
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(updateCaseStatusMock).toHaveBeenCalledWith({}, 'case1', 'new')
    expect(publishJsonMock).toHaveBeenCalledWith('/api/pipeline/research', { caseId: 'case1' })
    expect(body.requeuedCaseIds).toEqual(['case1'])
  })

  it('should reset a contacted case to ready and re-queue it to write', async () => {
    listStuckCasesMock.mockResolvedValue([{ id: 'case2', status: 'contacted' }])

    const res = await POST(req())
    const body = await res.json()

    expect(updateCaseStatusMock).toHaveBeenCalledWith({}, 'case2', 'ready')
    expect(publishJsonMock).toHaveBeenCalledWith('/api/pipeline/write', { caseId: 'case2' })
    expect(body.requeuedCaseIds).toEqual(['case2'])
  })

  it('should record a case as failed and keep going when its re-queue throws', async () => {
    listStuckCasesMock.mockResolvedValue([
      { id: 'case1', status: 'researching' },
      { id: 'case2', status: 'contacted' },
    ])
    publishJsonMock.mockRejectedValueOnce(new Error('qstash down')).mockResolvedValueOnce('msg2')

    const res = await POST(req())
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.failedCaseIds).toEqual(['case1'])
    expect(body.requeuedCaseIds).toEqual(['case2'])
  })

  it('should skip cases whose status is not a re-queueable in-progress state', async () => {
    listStuckCasesMock.mockResolvedValue([{ id: 'case9', status: 'won' }])

    const res = await POST(req())
    const body = await res.json()

    expect(updateCaseStatusMock).not.toHaveBeenCalled()
    expect(publishJsonMock).not.toHaveBeenCalled()
    expect(body.requeuedCaseIds).toEqual([])
  })

  it('should return 401 on an invalid QStash signature', async () => {
    const { AppError } = await import('@/lib/errors/app-error')
    verifyMock.mockRejectedValue(new AppError('UNAUTHORIZED', 'bad'))

    const res = await POST(req())

    expect(res.status).toBe(401)
    expect(listStuckCasesMock).not.toHaveBeenCalled()
  })
})
