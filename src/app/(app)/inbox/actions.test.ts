import { describe, it, expect, vi, beforeEach } from 'vitest'

const requireUserMock = vi.fn()
const createAdminClientMock = vi.fn()
const getEmailByIdMock = vi.fn()
const claimDraftForSendMock = vi.fn()
const markEmailSentMock = vi.fn()
const markEmailFailedMock = vi.fn()
const scheduleFirstFollowupMock = vi.fn()
const getCampaignForCaseMock = vi.fn()
const getLeadByIdMock = vi.fn()
const sendViaMailboxMock = vi.fn()
const revalidatePathMock = vi.fn()
const logEventSafeMock = vi.fn()
const claimAnswerMock = vi.fn()
const getKnowledgeRequestByIdMock = vi.fn()
const hasReplyForInboundMock = vi.fn()
const insertKnowledgeMock = vi.fn()
const runKnowledgeAnswerMock = vi.fn()

vi.mock('@/lib/auth/require-user', () => ({ requireUser: (...a: unknown[]) => requireUserMock(...a) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: (...a: unknown[]) => createAdminClientMock(...a) }))
vi.mock('@/lib/db/emails', () => ({
  getEmailById: (...a: unknown[]) => getEmailByIdMock(...a),
  claimDraftForSend: (...a: unknown[]) => claimDraftForSendMock(...a),
  markEmailSent: (...a: unknown[]) => markEmailSentMock(...a),
  markEmailFailed: (...a: unknown[]) => markEmailFailedMock(...a),
  hasReplyForInbound: (...a: unknown[]) => hasReplyForInboundMock(...a),
}))
vi.mock('@/lib/pipeline/followup', () => ({
  FIRST_TOUCH_STEP: 0,
  scheduleFirstFollowup: (...a: unknown[]) => scheduleFirstFollowupMock(...a),
}))
vi.mock('@/lib/db/campaigns', () => ({ getCampaignForCase: (...a: unknown[]) => getCampaignForCaseMock(...a) }))
vi.mock('@/lib/db/leads', () => ({ getLeadById: (...a: unknown[]) => getLeadByIdMock(...a) }))
vi.mock('@/lib/mailbox/sender', () => ({ sendViaMailbox: (...a: unknown[]) => sendViaMailboxMock(...a) }))
vi.mock('next/cache', () => ({ revalidatePath: (...a: unknown[]) => revalidatePathMock(...a) }))
vi.mock('@/lib/events/log-event', () => ({ logEventSafe: (...a: unknown[]) => logEventSafeMock(...a) }))
vi.mock('@/lib/db/knowledge-requests', () => ({
  claimKnowledgeRequestAnswer: (...a: unknown[]) => claimAnswerMock(...a),
  getKnowledgeRequestById: (...a: unknown[]) => getKnowledgeRequestByIdMock(...a),
}))
vi.mock('@/lib/db/case-knowledge', () => ({ insertKnowledge: (...a: unknown[]) => insertKnowledgeMock(...a) }))
vi.mock('@/lib/pipeline/knowledge-answer', () => ({ runKnowledgeAnswer: (...a: unknown[]) => runKnowledgeAnswerMock(...a) }))

import { approveDraft, answerKnowledgeRequest } from './actions'

const EMAIL_ID = '11111111-1111-4111-8111-111111111111'

function fd(emailId: string) {
  const f = new FormData()
  f.set('emailId', emailId)
  return f
}

function draftEmail(overrides: Record<string, unknown> = {}) {
  return {
    id: EMAIL_ID, client_id: 'c1', case_id: 'case1', lead_id: 'lead1',
    subject: 's', body: 'b', status: 'draft', direction: 'outbound', sequence_step: 0,
    ...overrides,
  }
}

const KR_ID = '22222222-2222-4222-8222-222222222222'
function krForm(fields: Record<string, string>) {
  const fd2 = new FormData()
  for (const [k, v] of Object.entries(fields)) fd2.set(k, v)
  return fd2
}

beforeEach(() => {
  for (const m of [requireUserMock, createAdminClientMock, getEmailByIdMock, claimDraftForSendMock,
    markEmailSentMock, markEmailFailedMock, scheduleFirstFollowupMock,
    getCampaignForCaseMock, getLeadByIdMock, sendViaMailboxMock,
    revalidatePathMock, logEventSafeMock, claimAnswerMock, getKnowledgeRequestByIdMock,
    hasReplyForInboundMock, insertKnowledgeMock, runKnowledgeAnswerMock]) m.mockReset()
  requireUserMock.mockResolvedValue({ user: { id: 'user1' }, appUser: { id: 'user1', role: 'operator' } })
  createAdminClientMock.mockReturnValue({})
  getLeadByIdMock.mockResolvedValue({ id: 'lead1', email: 'jane@acme.com' })
  getCampaignForCaseMock.mockResolvedValue({ mailbox_ids: ['m1'] })
  sendViaMailboxMock.mockResolvedValue({ mailboxId: 'm1', providerMessageId: 'pm1', threadId: 'thr1' })
  claimDraftForSendMock.mockResolvedValue(draftEmail({ status: 'queued' }))
  scheduleFirstFollowupMock.mockResolvedValue(undefined)
  claimAnswerMock.mockResolvedValue({ id: KR_ID, client_id: 'c1', case_id: 'case1' })
})

describe('approveDraft', () => {
  it('should send the draft, mark it sent, and schedule the follow-up sequence when approved', async () => {
    getEmailByIdMock.mockResolvedValue(draftEmail())

    await approveDraft(fd(EMAIL_ID))

    expect(claimDraftForSendMock).toHaveBeenCalledWith({}, EMAIL_ID)
    expect(sendViaMailboxMock).toHaveBeenCalled()
    expect(markEmailSentMock).toHaveBeenCalled()
    expect(scheduleFirstFollowupMock).toHaveBeenCalledWith({}, {
      clientId: 'c1', caseId: 'case1', leadId: 'lead1',
    })
    expect(revalidatePathMock).toHaveBeenCalledWith('/inbox')
  })

  it('should use the admin client, never a session-bound client, for the send', async () => {
    getEmailByIdMock.mockResolvedValue(draftEmail())

    await approveDraft(fd(EMAIL_ID))

    expect(createAdminClientMock).toHaveBeenCalled()
  })

  it('should reject a non-operator before any read or send', async () => {
    requireUserMock.mockResolvedValue({ user: { id: 'u2' }, appUser: { id: 'u2', role: 'client' } })

    await expect(approveDraft(fd(EMAIL_ID))).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    expect(getEmailByIdMock).not.toHaveBeenCalled()
    expect(sendViaMailboxMock).not.toHaveBeenCalled()
  })

  it('should not send when the atomic draft claim is lost to a concurrent approval', async () => {
    getEmailByIdMock.mockResolvedValue(draftEmail())
    claimDraftForSendMock.mockResolvedValue(null)

    await approveDraft(fd(EMAIL_ID))

    expect(sendViaMailboxMock).not.toHaveBeenCalled()
    expect(markEmailSentMock).not.toHaveBeenCalled()
    expect(scheduleFirstFollowupMock).not.toHaveBeenCalled()
    expect(revalidatePathMock).toHaveBeenCalledWith('/inbox')
  })

  it('should mark the email failed, revalidate, and rethrow when sending throws', async () => {
    getEmailByIdMock.mockResolvedValue(draftEmail())
    sendViaMailboxMock.mockRejectedValue(new Error('smtp down'))

    await expect(approveDraft(fd(EMAIL_ID))).rejects.toBeTruthy()
    expect(markEmailFailedMock).toHaveBeenCalledWith({}, EMAIL_ID)
    expect(markEmailSentMock).not.toHaveBeenCalled()
    expect(scheduleFirstFollowupMock).not.toHaveBeenCalled()
    expect(revalidatePathMock).toHaveBeenCalledWith('/inbox')
  })

  it('should rethrow the original send error even when markEmailFailed also fails', async () => {
    getEmailByIdMock.mockResolvedValue(draftEmail())
    const sendError = new Error('smtp down')
    sendViaMailboxMock.mockRejectedValue(sendError)
    markEmailFailedMock.mockRejectedValue(new Error('db unreachable'))

    await expect(approveDraft(fd(EMAIL_ID))).rejects.toBe(sendError)
    expect(revalidatePathMock).toHaveBeenCalledWith('/inbox')
  })

  it('should not fail the send when scheduling the first follow-up throws', async () => {
    getEmailByIdMock.mockResolvedValue(draftEmail())
    scheduleFirstFollowupMock.mockRejectedValue(new Error('qstash down'))

    await expect(approveDraft(fd(EMAIL_ID))).resolves.toBeUndefined()
    expect(markEmailSentMock).toHaveBeenCalled()
    expect(logEventSafeMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'inbox.schedule_followup_failed' }),
    )
    expect(revalidatePathMock).toHaveBeenCalledWith('/inbox')
  })

  it('should not start a second sequence when approving a non-first-touch step', async () => {
    getEmailByIdMock.mockResolvedValue(draftEmail({ sequence_step: 2 }))
    claimDraftForSendMock.mockResolvedValue(draftEmail({ status: 'queued', sequence_step: 2 }))

    await approveDraft(fd(EMAIL_ID))

    expect(sendViaMailboxMock).toHaveBeenCalled()
    expect(markEmailSentMock).toHaveBeenCalled()
    expect(scheduleFirstFollowupMock).not.toHaveBeenCalled()
  })

  it('should throw when the email is not a draft', async () => {
    getEmailByIdMock.mockResolvedValue({ id: EMAIL_ID, status: 'sent', direction: 'outbound' })

    await expect(approveDraft(fd(EMAIL_ID))).rejects.toBeTruthy()
    expect(claimDraftForSendMock).not.toHaveBeenCalled()
    expect(sendViaMailboxMock).not.toHaveBeenCalled()
  })
})

describe('answerKnowledgeRequest', () => {
  it('should reject non-operators', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'client' } })
    await expect(answerKnowledgeRequest(krForm({ knowledgeRequestId: KR_ID, answer: 'A' }))).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  })

  it('should claim, store the fact, and run the answer pipeline', async () => {
    await answerKnowledgeRequest(krForm({ knowledgeRequestId: KR_ID, answer: 'Our SLA is 99.9%' }))
    expect(claimAnswerMock).toHaveBeenCalledWith({}, expect.objectContaining({ id: KR_ID, answeredBy: 'user1' }))
    expect(insertKnowledgeMock).toHaveBeenCalledWith({}, [expect.objectContaining({ kind: 'answer', created_by: 'human', case_id: 'case1' })])
    expect(runKnowledgeAnswerMock).toHaveBeenCalledWith({}, { knowledgeRequestId: KR_ID })
  })

  it('should no-op when the request was already claimed and already replied to', async () => {
    claimAnswerMock.mockResolvedValue(null)
    getKnowledgeRequestByIdMock.mockResolvedValue({
      id: KR_ID, client_id: 'c1', case_id: 'case1', status: 'answered', email_id: 'in1',
    })
    hasReplyForInboundMock.mockResolvedValue(true)
    await answerKnowledgeRequest(krForm({ knowledgeRequestId: KR_ID, answer: 'A' }))
    expect(insertKnowledgeMock).not.toHaveBeenCalled()
    expect(runKnowledgeAnswerMock).not.toHaveBeenCalled()
  })

  it('should no-op when the claim lost the race to a dismissal', async () => {
    claimAnswerMock.mockResolvedValue(null)
    getKnowledgeRequestByIdMock.mockResolvedValue({
      id: KR_ID, client_id: 'c1', case_id: 'case1', status: 'dismissed', email_id: 'in1',
    })
    hasReplyForInboundMock.mockResolvedValue(false)
    await answerKnowledgeRequest(krForm({ knowledgeRequestId: KR_ID, answer: 'A' }))
    expect(insertKnowledgeMock).not.toHaveBeenCalled()
    expect(runKnowledgeAnswerMock).not.toHaveBeenCalled()
  })

  it('should recover an interrupted claim (answered but never replied) and complete the pipeline', async () => {
    claimAnswerMock.mockResolvedValue(null)
    getKnowledgeRequestByIdMock.mockResolvedValue({
      id: KR_ID, client_id: 'c1', case_id: 'case1', status: 'answered', email_id: 'in1',
    })
    hasReplyForInboundMock.mockResolvedValue(false)
    await answerKnowledgeRequest(krForm({ knowledgeRequestId: KR_ID, answer: 'Our SLA is 99.9%' }))
    expect(insertKnowledgeMock).toHaveBeenCalledWith({}, [expect.objectContaining({ kind: 'answer', case_id: 'case1' })])
    expect(runKnowledgeAnswerMock).toHaveBeenCalledWith({}, { knowledgeRequestId: KR_ID })
  })
})
