import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AppError } from '@/lib/errors/app-error'

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
const listAttachmentsForEmailMock = vi.fn()
const replaceEmailAttachmentsMock = vi.fn()
const loadResourceAttachmentsMock = vi.fn()
const resolveSelectedResourcesMock = vi.fn()
const updateDraftContentRowMock = vi.fn()
const regenerateDraftContentPipelineMock = vi.fn()

vi.mock('@/lib/auth/require-user', () => ({ requireUser: (...a: unknown[]) => requireUserMock(...a) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: (...a: unknown[]) => createAdminClientMock(...a) }))
vi.mock('@/lib/db/emails', () => ({
  getEmailById: (...a: unknown[]) => getEmailByIdMock(...a),
  claimDraftForSend: (...a: unknown[]) => claimDraftForSendMock(...a),
  markEmailSent: (...a: unknown[]) => markEmailSentMock(...a),
  markEmailFailed: (...a: unknown[]) => markEmailFailedMock(...a),
  hasReplyForInbound: (...a: unknown[]) => hasReplyForInboundMock(...a),
  updateDraftContent: (...a: unknown[]) => updateDraftContentRowMock(...a),
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
vi.mock('@/lib/db/email-attachments', () => ({
  listAttachmentsForEmail: (...a: unknown[]) => listAttachmentsForEmailMock(...a),
  replaceEmailAttachments: (...a: unknown[]) => replaceEmailAttachmentsMock(...a),
}))
vi.mock('@/lib/resources/load-attachments', () => ({
  loadResourceAttachments: (...a: unknown[]) => loadResourceAttachmentsMock(...a),
}))
vi.mock('@/lib/resources/select', () => ({
  resolveSelectedResources: (...a: unknown[]) => resolveSelectedResourcesMock(...a),
}))
vi.mock('@/lib/pipeline/redesign', () => ({
  regenerateDraftContent: (...a: unknown[]) => regenerateDraftContentPipelineMock(...a),
}))

import {
  approveDraft, answerKnowledgeRequest, updateDraftAttachments, updateDraftContent, regenerateDraftContent,
} from './actions'

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
    hasReplyForInboundMock, insertKnowledgeMock, runKnowledgeAnswerMock,
    listAttachmentsForEmailMock, replaceEmailAttachmentsMock, loadResourceAttachmentsMock,
    resolveSelectedResourcesMock, updateDraftContentRowMock, regenerateDraftContentPipelineMock]) m.mockReset()
  requireUserMock.mockResolvedValue({ user: { id: 'user1' }, appUser: { id: 'user1', role: 'operator', client_id: null } })
  listAttachmentsForEmailMock.mockResolvedValue([])
  replaceEmailAttachmentsMock.mockResolvedValue(undefined)
  loadResourceAttachmentsMock.mockResolvedValue([])
  resolveSelectedResourcesMock.mockResolvedValue([])
  getKnowledgeRequestByIdMock.mockResolvedValue({ id: KR_ID, client_id: 'c1', case_id: 'case1' })
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
    expect(runKnowledgeAnswerMock).toHaveBeenCalledWith({}, { knowledgeRequestId: KR_ID, resourceIds: [] })
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
    expect(runKnowledgeAnswerMock).toHaveBeenCalledWith({}, { knowledgeRequestId: KR_ID, resourceIds: [] })
  })
})

const R1 = '33333333-3333-4333-8333-333333333333'
const R2 = '44444444-4444-4444-8444-444444444444'

describe('answerKnowledgeRequest with attachments', () => {
  it('should pass the selected resource ids to the answer pipeline', async () => {
    const formData = krForm({ knowledgeRequestId: KR_ID, answer: 'Yes, here they are.' })
    formData.append('resourceIds', R1)
    formData.append('resourceIds', R2)

    await answerKnowledgeRequest(formData)

    expect(runKnowledgeAnswerMock).toHaveBeenCalledWith({}, {
      knowledgeRequestId: KR_ID, resourceIds: [R1, R2],
    })
  })

  it('should validate the picks against the request own client before claiming it', async () => {
    const formData = krForm({ knowledgeRequestId: KR_ID, answer: 'Yes, here they are.' })
    formData.append('resourceIds', R1)

    await answerKnowledgeRequest(formData)

    expect(resolveSelectedResourcesMock).toHaveBeenCalledWith({}, 'c1', [R1])
    expect(resolveSelectedResourcesMock.mock.invocationCallOrder[0]!)
      .toBeLessThan(claimAnswerMock.mock.invocationCallOrder[0]!)
  })

  it('should leave the request untouched when a pick cannot be resolved', async () => {
    resolveSelectedResourcesMock.mockRejectedValue(
      new AppError('VALIDATION_ERROR', 'One of the selected files is no longer available'),
    )
    const formData = krForm({ knowledgeRequestId: KR_ID, answer: 'Yes, here they are.' })
    formData.append('resourceIds', R1)

    await expect(answerKnowledgeRequest(formData)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })

    // Nothing was mutated, so the operator can fix the selection and resubmit.
    expect(claimAnswerMock).not.toHaveBeenCalled()
    expect(insertKnowledgeMock).not.toHaveBeenCalled()
    expect(runKnowledgeAnswerMock).not.toHaveBeenCalled()
  })

  // The file is uploaded to the knowledge route by the client before this action
  // runs, because a Server Action body is capped at 1MB. Any File still present
  // in the payload must be ignored rather than acted on.
  it('should not treat a stray file field as part of the answer', async () => {
    const formData = krForm({ knowledgeRequestId: KR_ID, answer: 'See attached notes.' })
    formData.set('knowledgeFile', new File(['notes'], 'notes.md', { type: 'text/markdown' }))

    await answerKnowledgeRequest(formData)

    expect(runKnowledgeAnswerMock).toHaveBeenCalledWith({}, {
      knowledgeRequestId: KR_ID, resourceIds: [],
    })
  })
})

describe('updateDraftAttachments', () => {
  it('should replace the attachment set on a draft', async () => {
    getEmailByIdMock.mockResolvedValue(draftEmail())

    const formData = new FormData()
    formData.set('emailId', EMAIL_ID)
    formData.append('resourceIds', R1)

    await updateDraftAttachments(formData)

    expect(resolveSelectedResourcesMock).toHaveBeenCalledWith({}, 'c1', [R1])
    expect(replaceEmailAttachmentsMock).toHaveBeenCalledWith({}, {
      clientId: 'c1', emailId: EMAIL_ID, resourceIds: [R1],
    })
    expect(revalidatePathMock).toHaveBeenCalledWith('/inbox')
  })

  it('should reject a pick that does not belong to the email own client', async () => {
    getEmailByIdMock.mockResolvedValue(draftEmail())
    resolveSelectedResourcesMock.mockRejectedValue(
      new AppError('VALIDATION_ERROR', 'One of the selected files is no longer available'),
    )

    const formData = new FormData()
    formData.set('emailId', EMAIL_ID)
    formData.append('resourceIds', R1)

    await expect(updateDraftAttachments(formData)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(replaceEmailAttachmentsMock).not.toHaveBeenCalled()
  })

  it('should reject a selection over the byte budget instead of writing it', async () => {
    getEmailByIdMock.mockResolvedValue(draftEmail())
    resolveSelectedResourcesMock.mockRejectedValue(
      new AppError('VALIDATION_ERROR', 'Attachments exceed the 3MB per-email limit'),
    )

    const formData = new FormData()
    formData.set('emailId', EMAIL_ID)
    formData.append('resourceIds', R1)
    formData.append('resourceIds', R2)

    await expect(updateDraftAttachments(formData)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(replaceEmailAttachmentsMock).not.toHaveBeenCalled()
  })

  it('should reject more ids than the per-email limit before touching the database', async () => {
    const formData = new FormData()
    formData.set('emailId', EMAIL_ID)
    for (const id of [R1, R2, R1, R2]) formData.append('resourceIds', id)

    await expect(updateDraftAttachments(formData)).rejects.toBeTruthy()
    expect(replaceEmailAttachmentsMock).not.toHaveBeenCalled()
  })

  it('should reject a non-operator', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'client', client_id: 'c1' } })
    const formData = new FormData()
    formData.set('emailId', EMAIL_ID)
    await expect(updateDraftAttachments(formData)).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    expect(replaceEmailAttachmentsMock).not.toHaveBeenCalled()
  })

  it('should reject an email that is no longer a draft', async () => {
    getEmailByIdMock.mockResolvedValue(draftEmail({ status: 'sent' }))
    const formData = new FormData()
    formData.set('emailId', EMAIL_ID)
    await expect(updateDraftAttachments(formData)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(replaceEmailAttachmentsMock).not.toHaveBeenCalled()
  })
})

describe('approveDraft attachments', () => {
  it('should send the attachment set recorded against the draft', async () => {
    getEmailByIdMock.mockResolvedValue(draftEmail({ in_reply_to_email_id: 'inb1' }))
    listAttachmentsForEmailMock.mockResolvedValue([{ resourceId: R1 }])
    const attachments = [{ fileName: 'a.pdf', mimeType: 'application/pdf', content: Buffer.from('X') }]
    loadResourceAttachmentsMock.mockResolvedValue(attachments)

    await approveDraft(fd(EMAIL_ID))

    expect(loadResourceAttachmentsMock).toHaveBeenCalledWith({}, 'c1', [R1])
    expect(sendViaMailboxMock).toHaveBeenCalledWith({}, expect.objectContaining({ attachments }))
  })

  // The draft survives on purpose: a deleted resource is something the operator
  // can fix by editing the attachments, so it must not be burned to 'failed'.
  it('should leave the draft approvable when an attachment cannot be loaded', async () => {
    getEmailByIdMock.mockResolvedValue(draftEmail({ in_reply_to_email_id: 'inb1' }))
    listAttachmentsForEmailMock.mockResolvedValue([{ resourceId: R1 }])
    loadResourceAttachmentsMock.mockRejectedValue(new Error('storage gone'))

    await expect(approveDraft(fd(EMAIL_ID))).rejects.toThrow('storage gone')
    expect(claimDraftForSendMock).not.toHaveBeenCalled()
    expect(markEmailFailedMock).not.toHaveBeenCalled()
    expect(sendViaMailboxMock).not.toHaveBeenCalled()
  })

  it('should still mark the draft failed when the send itself fails', async () => {
    getEmailByIdMock.mockResolvedValue(draftEmail({ in_reply_to_email_id: 'inb1' }))
    sendViaMailboxMock.mockRejectedValue(new Error('smtp down'))

    await expect(approveDraft(fd(EMAIL_ID))).rejects.toThrow('smtp down')
    expect(markEmailFailedMock).toHaveBeenCalledWith({}, EMAIL_ID)
  })
})

describe('updateDraftContent', () => {
  it('should persist the manually edited subject and body', async () => {
    updateDraftContentRowMock.mockResolvedValue(draftEmail({ subject: 'New subject', body: 'New body' }))
    const formData = new FormData()
    formData.set('emailId', EMAIL_ID)
    formData.set('subject', 'New subject')
    formData.set('body', 'New body')

    await updateDraftContent(formData)

    expect(updateDraftContentRowMock).toHaveBeenCalledWith(
      {}, EMAIL_ID, { subject: 'New subject', body: 'New body' },
    )
    expect(revalidatePathMock).toHaveBeenCalledWith('/inbox')
  })

  it('should reject a non-operator', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'client', client_id: 'c1' } })
    const formData = new FormData()
    formData.set('emailId', EMAIL_ID)
    formData.set('subject', 'New subject')
    formData.set('body', 'New body')

    await expect(updateDraftContent(formData)).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    expect(updateDraftContentRowMock).not.toHaveBeenCalled()
  })

  it('should reject an empty subject before touching the database', async () => {
    const formData = new FormData()
    formData.set('emailId', EMAIL_ID)
    formData.set('subject', '')
    formData.set('body', 'New body')

    await expect(updateDraftContent(formData)).rejects.toBeTruthy()
    expect(updateDraftContentRowMock).not.toHaveBeenCalled()
  })

  it('should throw VALIDATION_ERROR when the draft was already sent', async () => {
    updateDraftContentRowMock.mockResolvedValue(null)
    const formData = new FormData()
    formData.set('emailId', EMAIL_ID)
    formData.set('subject', 'New subject')
    formData.set('body', 'New body')

    await expect(updateDraftContent(formData)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(revalidatePathMock).not.toHaveBeenCalled()
  })
})

describe('regenerateDraftContent', () => {
  it('should redesign the draft and persist the result', async () => {
    regenerateDraftContentPipelineMock.mockResolvedValue({ subject: 'AI subject', body: 'AI body' })
    updateDraftContentRowMock.mockResolvedValue(draftEmail({ subject: 'AI subject', body: 'AI body' }))
    const formData = new FormData()
    formData.set('emailId', EMAIL_ID)
    formData.set('instruction', 'make it shorter')

    const result = await regenerateDraftContent(formData)

    expect(regenerateDraftContentPipelineMock).toHaveBeenCalledWith(
      {}, { emailId: EMAIL_ID, instruction: 'make it shorter' },
    )
    expect(updateDraftContentRowMock).toHaveBeenCalledWith({}, EMAIL_ID, { subject: 'AI subject', body: 'AI body' })
    expect(result).toEqual({ ok: true, subject: 'AI subject', body: 'AI body' })
    expect(revalidatePathMock).toHaveBeenCalledWith('/inbox')
  })

  it('should reject a non-operator', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'client', client_id: 'c1' } })
    const formData = new FormData()
    formData.set('emailId', EMAIL_ID)
    formData.set('instruction', 'make it shorter')

    await expect(regenerateDraftContent(formData)).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    expect(regenerateDraftContentPipelineMock).not.toHaveBeenCalled()
  })

  it('should reject an empty instruction before calling the pipeline', async () => {
    const formData = new FormData()
    formData.set('emailId', EMAIL_ID)
    formData.set('instruction', '')

    await expect(regenerateDraftContent(formData)).rejects.toBeTruthy()
    expect(regenerateDraftContentPipelineMock).not.toHaveBeenCalled()
  })

  it('should return ok:false with the error code when the LLM call fails, without throwing', async () => {
    regenerateDraftContentPipelineMock.mockRejectedValue(new AppError('EXTERNAL_ERROR', 'LLM generateObject failed'))
    const formData = new FormData()
    formData.set('emailId', EMAIL_ID)
    formData.set('instruction', 'make it shorter')

    const result = await regenerateDraftContent(formData)

    expect(result).toEqual({ ok: false, code: 'EXTERNAL_ERROR' })
    expect(updateDraftContentRowMock).not.toHaveBeenCalled()
  })

  it('should return ok:false when the draft was approved out from under the redesign', async () => {
    regenerateDraftContentPipelineMock.mockResolvedValue({ subject: 'AI subject', body: 'AI body' })
    updateDraftContentRowMock.mockResolvedValue(null)
    const formData = new FormData()
    formData.set('emailId', EMAIL_ID)
    formData.set('instruction', 'make it shorter')

    const result = await regenerateDraftContent(formData)

    expect(result).toEqual({ ok: false, code: 'VALIDATION_ERROR' })
    expect(revalidatePathMock).not.toHaveBeenCalled()
  })
})
