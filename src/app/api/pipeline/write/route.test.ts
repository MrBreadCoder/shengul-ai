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
const logErrorMock = vi.fn()
vi.mock('@/lib/events/log-event', () => ({ logError: (...a: unknown[]) => logErrorMock(...a) }))
const isModelOverloadedErrorMock = vi.fn()
vi.mock('@/lib/llm/client', () => ({ isModelOverloadedError: (...a: unknown[]) => isModelOverloadedErrorMock(...a) }))
const handleModelOverloadMock = vi.fn()
vi.mock('@/lib/pipeline/overload-retry', () => ({ handleModelOverload: (...a: unknown[]) => handleModelOverloadMock(...a) }))

import { POST } from './route'

const CASE_ID = '11111111-1111-4111-8111-111111111111'

function req(body: unknown) {
  return new Request('http://x/api/pipeline/write', { method: 'POST', body: JSON.stringify(body) })
}

beforeEach(() => {
  verifyMock.mockReset().mockResolvedValue(JSON.stringify({ caseId: CASE_ID }))
  getCaseByIdMock.mockReset(); updateCaseStatusMock.mockReset()
  getCampaignForCaseMock.mockReset(); runWriteMock.mockReset()
  logErrorMock.mockReset()
  isModelOverloadedErrorMock.mockReset()
  handleModelOverloadMock.mockReset()
})

describe('POST /api/pipeline/write', () => {
  it('should run write when the case is ready', async () => {
    getCaseByIdMock.mockResolvedValue({ id: CASE_ID, client_id: 'c1', status: 'ready', company_name: 'Acme' })
    getCampaignForCaseMock.mockResolvedValue({
      id: 'camp1', reply_mode: 'auto_send', value_prop: 'v', booking_link: 'b', mailbox_ids: ['m1'], status: 'active',
      signature_name: null, signature_title: null, phone: null, address: null,
    })
    runWriteMock.mockResolvedValue({ caseId: CASE_ID, sent: 1, drafted: 0 })
    const res = await POST(req({ caseId: CASE_ID }))
    expect(res.status).toBe(200)
    expect(runWriteMock).toHaveBeenCalled()
  })

  it('should claim the case as writing (not contacted) before running write', async () => {
    // Regression test for the false-'contacted'-on-failure bug (roadmap
    // 2026-08-12): claiming 'contacted' up front meant a write failure left
    // the case permanently reading 'contacted' with zero emails sent.
    getCaseByIdMock.mockResolvedValue({ id: CASE_ID, client_id: 'c1', status: 'ready', company_name: 'Acme' })
    getCampaignForCaseMock.mockResolvedValue({
      id: 'camp1', reply_mode: 'auto_send', value_prop: 'v', booking_link: 'b', mailbox_ids: ['m1'], status: 'active',
      signature_name: null, signature_title: null, phone: null, address: null,
    })
    runWriteMock.mockResolvedValue({ caseId: CASE_ID, sent: 1, drafted: 0 })
    await POST(req({ caseId: CASE_ID }))
    expect(updateCaseStatusMock).toHaveBeenCalledWith(expect.anything(), CASE_ID, 'writing')
    expect(updateCaseStatusMock).not.toHaveBeenCalledWith(expect.anything(), CASE_ID, 'contacted')
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

  it("should pass the campaign's signature override fields through to runWriteForCase", async () => {
    getCaseByIdMock.mockResolvedValue({ id: CASE_ID, client_id: 'c1', status: 'ready', company_name: 'Acme' })
    getCampaignForCaseMock.mockResolvedValue({
      id: 'camp1', reply_mode: 'auto_send', value_prop: 'v', booking_link: 'b', mailbox_ids: ['m1'], status: 'active',
      signature_name: 'John Smith', signature_title: 'Sales Director', phone: '+1 555 123 4567', address: '123 Main St',
    })
    runWriteMock.mockResolvedValue({ caseId: CASE_ID, sent: 1, drafted: 0 })

    await POST(req({ caseId: CASE_ID }))

    expect(runWriteMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        signatureName: 'John Smith',
        signatureTitle: 'Sales Director',
        signaturePhone: '+1 555 123 4567',
        signatureAddress: '123 Main St',
      }),
    )
  })
})

describe('write route error attribution', () => {
  it('should log the failure against the case client and return 500 when the pipeline throws a non-overload error', async () => {
    const { AppError } = await import('@/lib/errors/app-error')
    getCaseByIdMock.mockResolvedValue({ id: CASE_ID, client_id: 'c1', status: 'ready', company_name: 'Acme' })
    getCampaignForCaseMock.mockResolvedValue({
      id: 'camp1', reply_mode: 'auto_send', value_prop: 'v', booking_link: 'b', mailbox_ids: ['m1'], status: 'active',
      signature_name: null, signature_title: null, phone: null, address: null,
    })
    runWriteMock.mockRejectedValue(new AppError('DB_ERROR', 'connection reset', {}))

    const res = await POST(req({ caseId: CASE_ID }))

    expect(res.status).toBe(500)
    expect(logErrorMock.mock.calls[0]?.[0]).toMatchObject({
      clientId: 'c1',
      caseId: CASE_ID,
      type: 'pipeline.write.route_failed',
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

describe('write route model-overload handling', () => {
  it('should schedule a long retry and return 200 (not 500) when the pipeline throws a model-overloaded error', async () => {
    const overloadError = new Error('503 overloaded')
    getCaseByIdMock.mockResolvedValue({ id: CASE_ID, client_id: 'c1', status: 'ready', company_name: 'Acme' })
    getCampaignForCaseMock.mockResolvedValue({
      id: 'camp1', reply_mode: 'auto_send', value_prop: 'v', booking_link: 'b', mailbox_ids: ['m1'], status: 'active',
      signature_name: null, signature_title: null, phone: null, address: null,
    })
    runWriteMock.mockRejectedValue(overloadError)
    isModelOverloadedErrorMock.mockReturnValue(true)
    handleModelOverloadMock.mockResolvedValue({ scheduled: true, nextRetryCount: 1 })

    const res = await POST(req({ caseId: CASE_ID }))
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.overload).toEqual({ scheduled: true, nextRetryCount: 1 })
    expect(logErrorMock).not.toHaveBeenCalled()
    expect(handleModelOverloadMock).toHaveBeenCalledWith(expect.objectContaining({
      path: '/api/pipeline/write',
      caseId: CASE_ID,
      clientId: 'c1',
      actor: 'system',
      eventPrefix: 'pipeline.write',
      retryCount: 0,
      error: overloadError,
    }))
  })

  it('should pass a revert callback that resets the case back to ready', async () => {
    getCaseByIdMock.mockResolvedValue({ id: CASE_ID, client_id: 'c1', status: 'ready', company_name: 'Acme' })
    getCampaignForCaseMock.mockResolvedValue({
      id: 'camp1', reply_mode: 'auto_send', value_prop: 'v', booking_link: 'b', mailbox_ids: ['m1'], status: 'active',
      signature_name: null, signature_title: null, phone: null, address: null,
    })
    runWriteMock.mockRejectedValue(new Error('overloaded'))
    isModelOverloadedErrorMock.mockReturnValue(true)
    handleModelOverloadMock.mockResolvedValue({ scheduled: false })

    await POST(req({ caseId: CASE_ID }))

    const passedRevert = handleModelOverloadMock.mock.calls[0]?.[0]?.revert as () => Promise<void>
    updateCaseStatusMock.mockClear()
    await passedRevert()
    expect(updateCaseStatusMock).toHaveBeenCalledWith(expect.anything(), CASE_ID, 'ready')
  })

  it('should pass the retryCount from the request body through to handleModelOverload', async () => {
    verifyMock.mockResolvedValue(JSON.stringify({ caseId: CASE_ID, retryCount: 4 }))
    getCaseByIdMock.mockResolvedValue({ id: CASE_ID, client_id: 'c1', status: 'ready', company_name: 'Acme' })
    getCampaignForCaseMock.mockResolvedValue({
      id: 'camp1', reply_mode: 'auto_send', value_prop: 'v', booking_link: 'b', mailbox_ids: ['m1'], status: 'active',
      signature_name: null, signature_title: null, phone: null, address: null,
    })
    runWriteMock.mockRejectedValue(new Error('overloaded'))
    isModelOverloadedErrorMock.mockReturnValue(true)
    handleModelOverloadMock.mockResolvedValue({ scheduled: true, nextRetryCount: 5 })

    await POST(req({ caseId: CASE_ID, retryCount: 4 }))

    expect(handleModelOverloadMock).toHaveBeenCalledWith(expect.objectContaining({ retryCount: 4 }))
  })
})
