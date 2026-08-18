import { describe, it, expect, vi, beforeEach } from 'vitest'

const verifyMock = vi.fn()
const listCasesByStatusMock = vi.fn()
const publishJsonMock = vi.fn()
const logEventMock = vi.fn()

vi.mock('@/lib/qstash/verify', () => ({ verifyQstashSignature: (...a: unknown[]) => verifyMock(...a) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/db/cases', () => ({
  listCasesByStatus: (...a: unknown[]) => listCasesByStatusMock(...a),
  AUTO_RETRY_WAIT_REASONS: ['mailreach_gate', 'daily_cap', 'no_healthy_mailbox'],
}))
vi.mock('@/lib/qstash/client', () => ({ publishJson: (...a: unknown[]) => publishJsonMock(...a) }))
vi.mock('@/lib/events/log-event', () => ({ logEvent: (...a: unknown[]) => logEventMock(...a) }))

import { POST } from './route'

function req() {
  return new Request('http://x/api/pipeline/write-fanout', { method: 'POST', body: '{}' })
}

beforeEach(() => {
  verifyMock.mockReset().mockResolvedValue('{}')
  listCasesByStatusMock.mockReset()
  publishJsonMock.mockReset().mockResolvedValue('qmsg1')
  logEventMock.mockReset().mockResolvedValue(undefined)
})

describe('POST /api/pipeline/write-fanout', () => {
  it('should query both ready and waiting cases', async () => {
    listCasesByStatusMock.mockResolvedValue([])
    await POST(req())
    expect(listCasesByStatusMock).toHaveBeenCalledWith(expect.anything(), ['ready', 'waiting'], 200, undefined)
  })

  it('should dispatch a ready case', async () => {
    listCasesByStatusMock.mockResolvedValue([{ id: 'case1', status: 'ready', wait_reason: null }])
    await POST(req())
    expect(publishJsonMock).toHaveBeenCalledWith('/api/pipeline/write', { caseId: 'case1' })
  })

  it('should dispatch a waiting case with an auto-retry reason', async () => {
    listCasesByStatusMock.mockResolvedValue([{ id: 'case1', status: 'waiting', wait_reason: 'mailreach_gate' }])
    await POST(req())
    expect(publishJsonMock).toHaveBeenCalledWith('/api/pipeline/write', { caseId: 'case1' })
  })

  it('should not dispatch a waiting case that needs manual approval', async () => {
    listCasesByStatusMock.mockResolvedValue([{ id: 'case1', status: 'waiting', wait_reason: 'awaiting_manual_approval' }])
    const res = await POST(req())
    const json = await res.json()
    expect(publishJsonMock).not.toHaveBeenCalled()
    expect(json.caseCount).toBe(0)
  })

  it('should not dispatch a waiting case with no viable leads', async () => {
    listCasesByStatusMock.mockResolvedValue([{ id: 'case1', status: 'waiting', wait_reason: 'no_viable_leads' }])
    await POST(req())
    expect(publishJsonMock).not.toHaveBeenCalled()
  })

  it('should dispatch a mix, publishing and counting only the eligible ones', async () => {
    listCasesByStatusMock.mockResolvedValue([
      { id: 'case1', status: 'ready', wait_reason: null },
      { id: 'case2', status: 'waiting', wait_reason: 'daily_cap' },
      { id: 'case3', status: 'waiting', wait_reason: 'awaiting_manual_approval' },
    ])
    const res = await POST(req())
    const json = await res.json()
    expect(publishJsonMock).toHaveBeenCalledTimes(2)
    expect(publishJsonMock).toHaveBeenCalledWith('/api/pipeline/write', { caseId: 'case1' })
    expect(publishJsonMock).toHaveBeenCalledWith('/api/pipeline/write', { caseId: 'case2' })
    expect(json.caseCount).toBe(2)
  })

  it('should page past a full page of non-dispatchable waiting cases to reach a ready case behind them', async () => {
    // Regression test: dispatchability must be applied before FANOUT_LIMIT.
    // A full page (200) of cases stuck on manual approval must not be able
    // to consume the whole fetch and starve a dispatchable case sitting
    // further back in the queue.
    const stuckPage = Array.from({ length: 200 }, (_, i) => ({
      id: `stuck-${i}`,
      status: 'waiting',
      wait_reason: 'awaiting_manual_approval',
      created_at: `2026-08-18T00:00:${String(i).padStart(2, '0')}.000Z`,
    }))
    const readyCase = { id: 'case-ready', status: 'ready', wait_reason: null, created_at: '2026-08-18T00:05:00.000Z' }
    listCasesByStatusMock
      .mockResolvedValueOnce(stuckPage)
      .mockResolvedValueOnce([readyCase])

    const res = await POST(req())
    const json = await res.json()

    expect(listCasesByStatusMock).toHaveBeenCalledTimes(2)
    expect(listCasesByStatusMock).toHaveBeenNthCalledWith(
      1, expect.anything(), ['ready', 'waiting'], 200, undefined,
    )
    expect(listCasesByStatusMock).toHaveBeenNthCalledWith(
      2, expect.anything(), ['ready', 'waiting'], 200,
      { createdAt: stuckPage[199]!.created_at, id: stuckPage[199]!.id },
    )
    expect(publishJsonMock).toHaveBeenCalledWith('/api/pipeline/write', { caseId: 'case-ready' })
    expect(json.caseCount).toBe(1)
  })

  it('should stop paging once MAX_PAGES full non-dispatchable pages have been scanned', async () => {
    listCasesByStatusMock.mockImplementation(() =>
      Promise.resolve(Array.from({ length: 200 }, (_, i) => ({
        id: `stuck-${i}`,
        status: 'waiting',
        wait_reason: 'awaiting_manual_approval',
        created_at: `2026-08-18T00:00:${String(i).padStart(2, '0')}.000Z`,
      }))),
    )

    const res = await POST(req())
    const json = await res.json()

    expect(listCasesByStatusMock).toHaveBeenCalledTimes(10)
    expect(publishJsonMock).not.toHaveBeenCalled()
    expect(json.caseCount).toBe(0)
  })

  it('should return 401 on invalid signature', async () => {
    const { AppError } = await import('@/lib/errors/app-error')
    verifyMock.mockRejectedValue(new AppError('UNAUTHORIZED', 'bad'))
    const res = await POST(req())
    expect(res.status).toBe(401)
  })
})
