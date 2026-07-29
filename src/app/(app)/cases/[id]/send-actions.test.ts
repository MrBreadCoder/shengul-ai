import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AppError } from '@/lib/errors/app-error'

const requireUser = vi.fn()
const getCaseById = vi.fn()
const getLeadById = vi.fn()
const getCampaignForCase = vi.fn()
const resolveSelectedResources = vi.fn()
const loadResourceAttachments = vi.fn()
const listThreadEmails = vi.fn()
const hasInboundReply = vi.fn()
const claimOutboundEmail = vi.fn()
const insertManualEmail = vi.fn()
const insertEmailAttachments = vi.fn()
const markEmailSent = vi.fn()
const markEmailFailed = vi.fn()
const sendViaMailbox = vi.fn()
const scheduleFirstFollowup = vi.fn()
const requestFollowupSkip = vi.fn()
const updateCaseStatus = vi.fn()
const revalidatePath = vi.fn()

vi.mock('@/lib/auth/require-user', () => ({ requireUser: () => requireUser() }))
vi.mock('@/lib/supabase/server', () => ({ createServerClient: () => Promise.resolve({}) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('next/cache', () => ({ revalidatePath: (...a: unknown[]) => revalidatePath(...a) }))
vi.mock('@/lib/db/cases', () => ({
  getCaseById: (...a: unknown[]) => getCaseById(...a),
  updateCaseStatus: (...a: unknown[]) => updateCaseStatus(...a),
}))
vi.mock('@/lib/db/leads', () => ({ getLeadById: (...a: unknown[]) => getLeadById(...a) }))
vi.mock('@/lib/db/campaigns', () => ({ getCampaignForCase: (...a: unknown[]) => getCampaignForCase(...a) }))
vi.mock('@/lib/db/emails', () => ({
  listThreadEmails: (...a: unknown[]) => listThreadEmails(...a),
  hasInboundReply: (...a: unknown[]) => hasInboundReply(...a),
  claimOutboundEmail: (...a: unknown[]) => claimOutboundEmail(...a),
  insertManualEmail: (...a: unknown[]) => insertManualEmail(...a),
  markEmailSent: (...a: unknown[]) => markEmailSent(...a),
  markEmailFailed: (...a: unknown[]) => markEmailFailed(...a),
}))
vi.mock('@/lib/db/email-attachments', () => ({
  insertEmailAttachments: (...a: unknown[]) => insertEmailAttachments(...a),
}))
vi.mock('@/lib/resources/select', () => ({
  resolveSelectedResources: (...a: unknown[]) => resolveSelectedResources(...a),
}))
vi.mock('@/lib/resources/load-attachments', () => ({
  loadResourceAttachments: (...a: unknown[]) => loadResourceAttachments(...a),
}))
vi.mock('@/lib/mailbox/sender', () => ({ sendViaMailbox: (...a: unknown[]) => sendViaMailbox(...a) }))
vi.mock('@/lib/pipeline/followup', () => ({
  FIRST_TOUCH_STEP: 0,
  scheduleFirstFollowup: (...a: unknown[]) => scheduleFirstFollowup(...a),
}))
vi.mock('@/lib/db/sequences', () => ({ requestFollowupSkip: (...a: unknown[]) => requestFollowupSkip(...a) }))
vi.mock('@/lib/events/log-event', () => ({ logEventSafe: () => Promise.resolve() }))

const { sendManualEmail } = await import('./send-actions')

const CASE_ID = '22222222-2222-4222-8222-222222222222'
const LEAD_ID = '11111111-1111-4111-8111-111111111111'
const RESOURCE_ID = '44444444-4444-4444-8444-444444444444'

function form(overrides: Record<string, string> = {}): FormData {
  const data = new FormData()
  data.set('caseId', CASE_ID)
  data.set('leadId', LEAD_ID)
  data.set('subject', 'Following up on our call')
  data.set('body', 'Hi Jane — as promised, the pricing sheet.')
  for (const [key, value] of Object.entries(overrides)) data.set(key, value)
  return data
}

beforeEach(() => {
  vi.clearAllMocks()
  requireUser.mockResolvedValue({ appUser: { id: 'u1', role: 'client', client_id: 'c1' } })
  getCaseById.mockResolvedValue({ id: CASE_ID, client_id: 'c1', status: 'ready' })
  getLeadById.mockResolvedValue({ id: LEAD_ID, client_id: 'c1', case_id: CASE_ID, email: 'jane@target.com' })
  getCampaignForCase.mockResolvedValue({ id: 'camp1', mailbox_ids: ['m1'], status: 'active' })
  resolveSelectedResources.mockResolvedValue([])
  loadResourceAttachments.mockResolvedValue([])
  listThreadEmails.mockResolvedValue([])
  hasInboundReply.mockResolvedValue(false)
  claimOutboundEmail.mockResolvedValue({ id: 'e1' })
  insertManualEmail.mockResolvedValue({ id: 'e2' })
  sendViaMailbox.mockResolvedValue({ mailboxId: 'm1', providerMessageId: '<pm@mail>', threadId: 'thr1' })
})

describe('sendManualEmail — authorization', () => {
  it('should reject when the RLS-scoped read finds no such case', async () => {
    getCaseById.mockResolvedValue(null)
    await expect(sendManualEmail(form())).resolves.toEqual({ ok: false, code: 'NOT_FOUND' })
    expect(sendViaMailbox).not.toHaveBeenCalled()
  })

  it('should reject a case belonging to another client', async () => {
    requireUser.mockResolvedValue({ appUser: { id: 'u2', role: 'client', client_id: 'other' } })
    await expect(sendManualEmail(form())).resolves.toEqual({ ok: false, code: 'UNAUTHORIZED' })
    expect(sendViaMailbox).not.toHaveBeenCalled()
  })

  it('should reject a lead that is not on this case', async () => {
    getLeadById.mockResolvedValue({ id: LEAD_ID, client_id: 'c1', case_id: 'other-case', email: 'x@y.com' })
    await expect(sendManualEmail(form())).resolves.toEqual({ ok: false, code: 'VALIDATION_ERROR' })
    expect(sendViaMailbox).not.toHaveBeenCalled()
  })

  it('should reject a lead with no address', async () => {
    getLeadById.mockResolvedValue({ id: LEAD_ID, client_id: 'c1', case_id: CASE_ID, email: null })
    await expect(sendManualEmail(form())).resolves.toEqual({ ok: false, code: 'VALIDATION_ERROR' })
  })

  it('should reject a campaign with no mailbox connected', async () => {
    getCampaignForCase.mockResolvedValue({ id: 'camp1', mailbox_ids: [], status: 'active' })
    await expect(sendManualEmail(form())).resolves.toEqual({ ok: false, code: 'VALIDATION_ERROR' })
    expect(sendViaMailbox).not.toHaveBeenCalled()
  })

  it('should reject sending through a paused campaign', async () => {
    getCampaignForCase.mockResolvedValue({ id: 'camp1', mailbox_ids: ['m1'], status: 'paused' })
    await expect(sendManualEmail(form())).resolves.toEqual({ ok: false, code: 'VALIDATION_ERROR' })
    expect(sendViaMailbox).not.toHaveBeenCalled()
  })

  it('should reject sending through an archived campaign', async () => {
    getCampaignForCase.mockResolvedValue({ id: 'camp1', mailbox_ids: ['m1'], status: 'archived' })
    await expect(sendManualEmail(form())).resolves.toEqual({ ok: false, code: 'VALIDATION_ERROR' })
    expect(sendViaMailbox).not.toHaveBeenCalled()
  })

  it('should let an operator send on any client', async () => {
    requireUser.mockResolvedValue({ appUser: { id: 'op', role: 'operator', client_id: null } })
    await sendManualEmail(form())
    expect(sendViaMailbox).toHaveBeenCalled()
  })
})

describe('sendManualEmail — first touch', () => {
  it('should claim step 0, send with the cap bypassed, and start the cadence', async () => {
    await sendManualEmail(form())

    expect(claimOutboundEmail).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ sequence_step: 0, sent_by: 'u1', status: 'queued', direction: 'outbound' }),
    )
    expect(insertManualEmail).not.toHaveBeenCalled()
    expect(sendViaMailbox).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        purpose: 'outreach', bypassDailyCap: true, bypassMailreachGate: true, to: 'jane@target.com',
      }),
    )
    expect(markEmailSent).toHaveBeenCalledWith(expect.anything(), 'e1', {
      providerMessageId: '<pm@mail>', threadId: 'thr1', mailboxId: 'm1',
    })
    expect(scheduleFirstFollowup).toHaveBeenCalledWith(expect.anything(), {
      clientId: 'c1', caseId: CASE_ID, leadId: LEAD_ID,
    })
    expect(updateCaseStatus).toHaveBeenCalledWith(expect.anything(), CASE_ID, 'contacted')
    expect(requestFollowupSkip).not.toHaveBeenCalled()
  })

  it('should leave the status alone on a case already past first contact', async () => {
    getCaseById.mockResolvedValue({ id: CASE_ID, client_id: 'c1', status: 'replied' })
    await sendManualEmail(form())
    expect(updateCaseStatus).not.toHaveBeenCalled()
  })
})

describe('sendManualEmail — interjection', () => {
  beforeEach(() => {
    claimOutboundEmail.mockResolvedValue(null) // step 0 already taken by the agent
  })

  it('should record a null-step email and request one follow-up skip', async () => {
    await sendManualEmail(form())

    expect(insertManualEmail).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ sequence_step: null, sent_by: 'u1' }),
    )
    expect(requestFollowupSkip).toHaveBeenCalledWith(expect.anything(), LEAD_ID)
    expect(scheduleFirstFollowup).not.toHaveBeenCalled()
    expect(updateCaseStatus).not.toHaveBeenCalled()
    expect(markEmailSent).toHaveBeenCalledWith(expect.anything(), 'e2', expect.anything())
  })

  it('should thread onto the existing conversation and send as a reply once the lead has written back', async () => {
    listThreadEmails.mockResolvedValue([
      { direction: 'outbound', thread_id: 'thr1', provider_message_id: '<a@mail>' },
      { direction: 'inbound', thread_id: 'thr1', provider_message_id: '<b@mail>' },
    ])
    hasInboundReply.mockResolvedValue(true)

    await sendManualEmail(form())

    expect(sendViaMailbox).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        purpose: 'reply', threadId: 'thr1', inReplyToMessageId: '<b@mail>', references: '<b@mail>',
      }),
    )
  })
})

describe('sendManualEmail — attachments and failures', () => {
  it('should record the attachments it resolved', async () => {
    const data = form()
    data.append('resourceIds', RESOURCE_ID)

    await sendManualEmail(data)

    expect(resolveSelectedResources).toHaveBeenCalledWith(expect.anything(), 'c1', [RESOURCE_ID])
    expect(insertEmailAttachments).toHaveBeenCalledWith(expect.anything(), {
      clientId: 'c1', emailId: 'e1', resourceIds: [RESOURCE_ID],
    })
  })

  it('should claim no row when the attachment selection is invalid', async () => {
    resolveSelectedResources.mockRejectedValue(
      new AppError('VALIDATION_ERROR', 'One of the selected files is no longer available', {}),
    )
    const data = form()
    data.append('resourceIds', RESOURCE_ID)

    await expect(sendManualEmail(data)).resolves.toEqual({ ok: false, code: 'VALIDATION_ERROR' })
    expect(claimOutboundEmail).not.toHaveBeenCalled()
    expect(sendViaMailbox).not.toHaveBeenCalled()
  })

  it('should mark the email failed and report it, not throw, when the send fails', async () => {
    sendViaMailbox.mockRejectedValue(new AppError('FORBIDDEN', 'Recipient is suppressed', {}))

    await expect(sendManualEmail(form())).resolves.toEqual({ ok: false, code: 'FORBIDDEN' })
    expect(markEmailFailed).toHaveBeenCalledWith(expect.anything(), 'e1')
    expect(markEmailSent).not.toHaveBeenCalled()
    expect(scheduleFirstFollowup).not.toHaveBeenCalled()
  })

  it('should not report a failed send when only the bookkeeping throws', async () => {
    scheduleFirstFollowup.mockRejectedValue(new Error('qstash down'))
    await expect(sendManualEmail(form())).resolves.toEqual({ ok: true })
    expect(markEmailSent).toHaveBeenCalled()
  })

  it('should reject an empty body before touching anything', async () => {
    await expect(sendManualEmail(form({ body: '   ' }))).rejects.toThrow()
    expect(claimOutboundEmail).not.toHaveBeenCalled()
  })
})
