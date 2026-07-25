import { describe, it, expect, vi, beforeEach } from 'vitest'

const verifyMock = vi.fn()
const getCaseByIdMock = vi.fn()
const updateCaseStatusMock = vi.fn()
const listActiveLeadsMock = vi.fn()
const getCampaignForCaseMock = vi.fn()
const runResearchMock = vi.fn()

vi.mock('@/lib/qstash/verify', () => ({ verifyQstashSignature: (...a: unknown[]) => verifyMock(...a) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/db/cases', () => ({
  getCaseById: (...a: unknown[]) => getCaseByIdMock(...a),
  updateCaseStatus: (...a: unknown[]) => updateCaseStatusMock(...a),
}))
vi.mock('@/lib/db/leads', () => ({ listActiveLeadsForCase: (...a: unknown[]) => listActiveLeadsMock(...a) }))
vi.mock('@/lib/db/campaigns', () => ({ getCampaignForCase: (...a: unknown[]) => getCampaignForCaseMock(...a) }))
vi.mock('@/lib/pipeline/research', () => ({ runResearchForCase: (...a: unknown[]) => runResearchMock(...a) }))
vi.mock('@/lib/research/brightdata', () => ({ brightdataResearch: { search: vi.fn() } }))
const logErrorMock = vi.fn()
vi.mock('@/lib/events/log-event', () => ({ logError: (...a: unknown[]) => logErrorMock(...a) }))

import { POST } from './route'

const CASE_ID = '11111111-1111-4111-8111-111111111111'

function req(body: unknown) {
  return new Request('http://x/api/pipeline/research', { method: 'POST', body: JSON.stringify(body) })
}

beforeEach(() => {
  verifyMock.mockReset().mockResolvedValue(JSON.stringify({ caseId: CASE_ID }))
  getCaseByIdMock.mockReset(); updateCaseStatusMock.mockReset()
  listActiveLeadsMock.mockReset(); getCampaignForCaseMock.mockReset(); runResearchMock.mockReset()
  logErrorMock.mockReset()
})

describe('POST /api/pipeline/research', () => {
  it('should run research and return ok when the case is new', async () => {
    verifyMock.mockResolvedValue(JSON.stringify({ caseId: CASE_ID }))
    getCaseByIdMock.mockResolvedValue({ id: CASE_ID, client_id: 'c1', status: 'new', company_name: 'Acme', company_domain: 'acme.com' })
    getCampaignForCaseMock.mockResolvedValue({ id: 'camp1', value_prop: 'v', status: 'active' })
    listActiveLeadsMock.mockResolvedValue([{ full_name: 'Jane', title: 'CTO' }])
    runResearchMock.mockResolvedValue({ caseId: CASE_ID, knowledgeCount: 2 })
    const res = await POST(req({ caseId: CASE_ID }))
    expect(res.status).toBe(200)
    expect(updateCaseStatusMock).toHaveBeenCalledWith(expect.anything(), CASE_ID, 'researching')
    expect(runResearchMock).toHaveBeenCalled()
  })

  it('should skip when the case is not new', async () => {
    getCaseByIdMock.mockResolvedValue({ id: CASE_ID, status: 'ready' })
    const res = await POST(req({ caseId: CASE_ID }))
    const json = await res.json()
    expect(json.skipped).toBe('case_not_new')
    expect(runResearchMock).not.toHaveBeenCalled()
  })

  it('should skip without claiming the case when the campaign is not active', async () => {
    getCaseByIdMock.mockResolvedValue({ id: CASE_ID, client_id: 'c1', status: 'new', company_name: 'Acme', company_domain: 'acme.com' })
    getCampaignForCaseMock.mockResolvedValue({ id: 'camp1', value_prop: 'v', status: 'paused' })
    const res = await POST(req({ caseId: CASE_ID }))
    const json = await res.json()
    expect(json.skipped).toBe('campaign_not_active')
    expect(updateCaseStatusMock).not.toHaveBeenCalled()
    expect(runResearchMock).not.toHaveBeenCalled()
  })

  it('should return 401 when the signature is invalid', async () => {
    const { AppError } = await import('@/lib/errors/app-error')
    verifyMock.mockRejectedValue(new AppError('UNAUTHORIZED', 'bad sig'))
    const res = await POST(req({ caseId: CASE_ID }))
    expect(res.status).toBe(401)
  })
})

describe('research route error attribution', () => {
  it('should log the failure against the case client when the pipeline throws', async () => {
    const { AppError } = await import('@/lib/errors/app-error')
    getCaseByIdMock.mockResolvedValue({
      id: CASE_ID, client_id: 'c1', status: 'new', company_name: 'Acme', company_domain: 'acme.com',
    })
    getCampaignForCaseMock.mockResolvedValue({ id: 'camp1', value_prop: 'v', status: 'active' })
    listActiveLeadsMock.mockResolvedValue([])
    runResearchMock.mockRejectedValue(new AppError('DB_ERROR', 'connection reset', {}))

    const res = await POST(req({ caseId: CASE_ID }))

    expect(res.status).toBe(500)
    expect(logErrorMock.mock.calls[0]?.[0]).toMatchObject({
      clientId: 'c1',
      caseId: CASE_ID,
      type: 'pipeline.research.route_failed',
      source: 'pipeline',
    })
  })

  it('should not log an error when the request signature is invalid', async () => {
    const { AppError } = await import('@/lib/errors/app-error')
    verifyMock.mockRejectedValue(new AppError('UNAUTHORIZED', 'bad signature', {}))

    const res = await POST(req({ caseId: CASE_ID }))

    expect(res.status).toBe(401)
    expect(logErrorMock).not.toHaveBeenCalled()
  })
})
