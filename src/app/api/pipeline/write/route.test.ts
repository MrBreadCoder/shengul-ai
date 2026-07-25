import { describe, it, expect, vi, beforeEach } from 'vitest'

const verifyMock = vi.fn()
const getCaseByIdMock = vi.fn()
const updateCaseStatusMock = vi.fn()
const getCampaignForCaseMock = vi.fn()
const runWriteMock = vi.fn()

vi.mock('@/lib/qstash/verify', () => ({ verifyQstashSignature: (...a: unknown[]) => verifyMock(...a) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/db/cases', () => ({
  getCaseById: (...a: unknown[]) => getCaseByIdMock(...a),
  updateCaseStatus: (...a: unknown[]) => updateCaseStatusMock(...a),
}))
vi.mock('@/lib/db/campaigns', () => ({ getCampaignForCase: (...a: unknown[]) => getCampaignForCaseMock(...a) }))
vi.mock('@/lib/pipeline/write', () => ({ runWriteForCase: (...a: unknown[]) => runWriteMock(...a) }))

import { POST } from './route'

const CASE_ID = '11111111-1111-4111-8111-111111111111'

function req(body: unknown) {
  return new Request('http://x/api/pipeline/write', { method: 'POST', body: JSON.stringify(body) })
}

beforeEach(() => {
  verifyMock.mockReset().mockResolvedValue(JSON.stringify({ caseId: CASE_ID }))
  getCaseByIdMock.mockReset(); updateCaseStatusMock.mockReset()
  getCampaignForCaseMock.mockReset(); runWriteMock.mockReset()
})

describe('POST /api/pipeline/write', () => {
  it('should run write when the case is ready', async () => {
    getCaseByIdMock.mockResolvedValue({ id: CASE_ID, client_id: 'c1', status: 'ready', company_name: 'Acme' })
    getCampaignForCaseMock.mockResolvedValue({
      id: 'camp1', reply_mode: 'auto_send', value_prop: 'v', booking_link: 'b', mailbox_ids: ['m1'], status: 'active',
    })
    runWriteMock.mockResolvedValue({ caseId: CASE_ID, sent: 1, drafted: 0 })
    const res = await POST(req({ caseId: CASE_ID }))
    expect(res.status).toBe(200)
    expect(runWriteMock).toHaveBeenCalled()
  })

  it('should skip when the case is not ready', async () => {
    getCaseByIdMock.mockResolvedValue({ id: CASE_ID, status: 'new' })
    const res = await POST(req({ caseId: CASE_ID }))
    const json = await res.json()
    expect(json.skipped).toBe('case_not_ready')
    expect(runWriteMock).not.toHaveBeenCalled()
  })

  it('should skip without claiming the case when the campaign is not active', async () => {
    getCaseByIdMock.mockResolvedValue({ id: CASE_ID, client_id: 'c1', status: 'ready', company_name: 'Acme' })
    getCampaignForCaseMock.mockResolvedValue({
      id: 'camp1', reply_mode: 'auto_send', value_prop: 'v', booking_link: 'b', mailbox_ids: ['m1'], status: 'paused',
    })
    const res = await POST(req({ caseId: CASE_ID }))
    const json = await res.json()
    expect(json.skipped).toBe('campaign_not_active')
    expect(updateCaseStatusMock).not.toHaveBeenCalled()
    expect(runWriteMock).not.toHaveBeenCalled()
  })

  it('should return 401 on invalid signature', async () => {
    const { AppError } = await import('@/lib/errors/app-error')
    verifyMock.mockRejectedValue(new AppError('UNAUTHORIZED', 'bad'))
    const res = await POST(req({ caseId: CASE_ID }))
    expect(res.status).toBe(401)
  })
})
