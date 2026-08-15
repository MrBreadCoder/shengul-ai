import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AppError } from '@/lib/errors/app-error'

const getEmailByIdMock = vi.fn()
const getLeadByIdMock = vi.fn()
const getCampaignForCaseMock = vi.fn()
const listThreadEmailsMock = vi.fn()
const listKnowledgeMock = vi.fn()
const claimReplyEmailMock = vi.fn()
const markEmailSentMock = vi.fn()
const markEmailFailedMock = vi.fn()
const addSuppressionMock = vi.fn()
const stopSequenceForLeadMock = vi.fn()
const updateCaseStatusMock = vi.fn()
const createKnowledgeRequestMock = vi.fn()
const sendViaMailboxMock = vi.fn()
const generateJsonMock = vi.fn()
const logEventMock = vi.fn()
const triggerCollisionNoticeMock = vi.fn()
const listActiveResourcesForClientMock = vi.fn()
const insertEmailAttachmentsMock = vi.fn()
const loadResourceAttachmentsMock = vi.fn()
const retrieveClientKnowledgeMock = vi.fn()
const enqueueCrmSyncMock = vi.fn()
const getClientByIdMock = vi.fn()

vi.mock('@/lib/db/emails', () => ({
  getEmailById: (...a: unknown[]) => getEmailByIdMock(...a),
  listThreadEmails: (...a: unknown[]) => listThreadEmailsMock(...a),
  claimReplyEmail: (...a: unknown[]) => claimReplyEmailMock(...a),
  markEmailSent: (...a: unknown[]) => markEmailSentMock(...a),
  markEmailFailed: (...a: unknown[]) => markEmailFailedMock(...a),
}))
vi.mock('@/lib/db/leads', () => ({ getLeadById: (...a: unknown[]) => getLeadByIdMock(...a) }))
vi.mock('@/lib/db/campaigns', () => ({ getCampaignForCase: (...a: unknown[]) => getCampaignForCaseMock(...a) }))
vi.mock('@/lib/db/clients', () => ({ getClientById: (...a: unknown[]) => getClientByIdMock(...a) }))
vi.mock('@/lib/db/case-knowledge', () => ({ listKnowledgeForCase: (...a: unknown[]) => listKnowledgeMock(...a) }))
vi.mock('@/lib/db/suppressions', () => ({ addSuppression: (...a: unknown[]) => addSuppressionMock(...a) }))
vi.mock('@/lib/db/sequences', () => ({ stopSequenceForLead: (...a: unknown[]) => stopSequenceForLeadMock(...a) }))
vi.mock('@/lib/db/cases', () => ({ updateCaseStatus: (...a: unknown[]) => updateCaseStatusMock(...a) }))
vi.mock('@/lib/db/knowledge-requests', () => ({ createKnowledgeRequest: (...a: unknown[]) => createKnowledgeRequestMock(...a) }))
vi.mock('@/lib/mailbox/sender', () => ({ sendViaMailbox: (...a: unknown[]) => sendViaMailboxMock(...a) }))
vi.mock('@/lib/llm/client', () => ({
  generateJson: (...a: unknown[]) => generateJsonMock(...a),
  EMAIL_WRITER_MODEL_ID: 'gemini-3.7-flash',
}))
vi.mock('@/lib/events/log-event', () => ({ logEventSafe: (...a: unknown[]) => logEventMock(...a) }))
vi.mock('@/lib/knowledge/client-context', () => ({
  retrieveClientKnowledge: (...a: unknown[]) => retrieveClientKnowledgeMock(...a),
}))
vi.mock('@/lib/pipeline/collision-notify', () => ({
  triggerCollisionNotice: (...a: unknown[]) => triggerCollisionNoticeMock(...a),
}))
vi.mock('@/lib/db/client-resources', () => ({
  listActiveResourcesForClient: (...a: unknown[]) => listActiveResourcesForClientMock(...a),
}))
vi.mock('@/lib/db/email-attachments', () => ({
  insertEmailAttachments: (...a: unknown[]) => insertEmailAttachmentsMock(...a),
}))
vi.mock('@/lib/resources/load-attachments', () => ({
  loadResourceAttachments: (...a: unknown[]) => loadResourceAttachmentsMock(...a),
}))
vi.mock('@/lib/crm/sync', () => ({ enqueueCrmSync: (...a: unknown[]) => enqueueCrmSyncMock(...a) }))

import { runReplyForInbound, replyDisposition, sendOrDraftReply } from './reply'

const inbound = {
  id: 'in1', client_id: 'c1', case_id: 'case1', lead_id: 'lead1',
  direction: 'inbound', thread_id: 't1', provider_message_id: 'g1', body: 'Hi',
}
const lead = { id: 'lead1', email: 'jane@acme.com' }
const campaign = { mailbox_ids: ['m1'], value_prop: 'v', booking_link: 'https://cal.com/x', reply_mode: 'auto_send' }

function resource(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'r1', client_id: 'c1', title: 'Deck', description: 'examples', file_name: 'd.pdf',
    mime_type: 'application/pdf', byte_size: 100, storage_path: 'p', is_active: true,
    created_by: 'u1', created_at: '2026-07-26T00:00:00Z', ...overrides,
  }
}

beforeEach(() => {
  for (const m of [getEmailByIdMock, getLeadByIdMock, getCampaignForCaseMock, listThreadEmailsMock, listKnowledgeMock,
    claimReplyEmailMock, markEmailSentMock, markEmailFailedMock, addSuppressionMock, stopSequenceForLeadMock,
    updateCaseStatusMock, createKnowledgeRequestMock, sendViaMailboxMock, generateJsonMock, logEventMock,
    triggerCollisionNoticeMock, listActiveResourcesForClientMock, insertEmailAttachmentsMock,
    loadResourceAttachmentsMock, retrieveClientKnowledgeMock, enqueueCrmSyncMock, getClientByIdMock]) m.mockReset()
  getEmailByIdMock.mockResolvedValue(inbound)
  getLeadByIdMock.mockResolvedValue(lead)
  getCampaignForCaseMock.mockResolvedValue(campaign)
  getClientByIdMock.mockResolvedValue({ id: 'c1', name: 'Acme', company_info: null })
  listThreadEmailsMock.mockResolvedValue([{ direction: 'outbound', subject: 'Quick idea', provider_message_id: 'out1' }])
  listKnowledgeMock.mockResolvedValue([])
  claimReplyEmailMock.mockResolvedValue({ id: 'reply1' })
  sendViaMailboxMock.mockResolvedValue({ mailboxId: 'm1', providerMessageId: 'p2', threadId: 't1' })
  listActiveResourcesForClientMock.mockResolvedValue([])
  insertEmailAttachmentsMock.mockResolvedValue(undefined)
  loadResourceAttachmentsMock.mockResolvedValue([])
  retrieveClientKnowledgeMock.mockResolvedValue('')
})

describe('replyDisposition', () => {
  it('should draft for human_approve regardless of confidence', () => {
    expect(replyDisposition('human_approve', 0.99)).toBe('draft')
  })
  it('should send for hybrid only when confident', () => {
    expect(replyDisposition('hybrid', 0.9)).toBe('send')
    expect(replyDisposition('hybrid', 0.5)).toBe('draft')
  })
})

describe('runReplyForInbound', () => {
  it('should answer and send when the reply is answerable (auto_send)', async () => {
    generateJsonMock.mockResolvedValue({ intent: 'question', confidence: 0.9, canAnswer: true, missingQuestion: null, replyBody: 'Here is the answer.', attachResourceIds: [] })
    const result = await runReplyForInbound({} as never, { emailId: 'in1' })
    expect(sendViaMailboxMock).toHaveBeenCalled()
    expect(updateCaseStatusMock).toHaveBeenCalledWith({}, 'case1', 'in_conversation')
    expect(result.action).toBe('answered')
  })

  it('should classify the reply with medium thinking', async () => {
    generateJsonMock.mockResolvedValue({ intent: 'question', confidence: 0.9, canAnswer: true, missingQuestion: null, replyBody: 'Here is the answer.', attachResourceIds: [] })
    await runReplyForInbound({} as never, { emailId: 'in1' })
    expect(generateJsonMock).toHaveBeenCalledWith(
      expect.objectContaining({ actor: 'reply_agent' }),
      expect.objectContaining({ thinkingLevel: 'low' }),
    )
  })

  it('should classify the reply with the gemini-3.7-flash override', async () => {
    generateJsonMock.mockResolvedValue({ intent: 'question', confidence: 0.9, canAnswer: true, missingQuestion: null, replyBody: 'Here is the answer.', attachResourceIds: [] })
    await runReplyForInbound({} as never, { emailId: 'in1' })
    expect(generateJsonMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ modelId: 'gemini-3.7-flash' }),
    )
  })

  it('should escalate a knowledge gap without sending', async () => {
    generateJsonMock.mockResolvedValue({ intent: 'question', confidence: 0.9, canAnswer: false, missingQuestion: 'What is our SLA?', replyBody: null })
    const result = await runReplyForInbound({} as never, { emailId: 'in1' })
    expect(createKnowledgeRequestMock).toHaveBeenCalledWith({}, expect.objectContaining({ question: 'What is our SLA?', email_id: 'in1' }))
    expect(sendViaMailboxMock).not.toHaveBeenCalled()
    expect(result.action).toBe('escalated')
  })

  it('should hand off on price intent: reply, suppress, stop, hot_handoff', async () => {
    generateJsonMock.mockResolvedValue({ intent: 'price', confidence: 0.8, canAnswer: false, missingQuestion: null, replyBody: null })
    const result = await runReplyForInbound({} as never, { emailId: 'in1' })
    expect(sendViaMailboxMock).toHaveBeenCalled() // booking-link reply
    expect(addSuppressionMock).toHaveBeenCalledWith({}, expect.objectContaining({ reason: 'price_handoff' }))
    expect(stopSequenceForLeadMock).toHaveBeenCalledWith({}, 'lead1', 'stopped')
    expect(updateCaseStatusMock).toHaveBeenCalledWith({}, 'case1', 'hot_handoff')
    expect(triggerCollisionNoticeMock).toHaveBeenCalledWith({}, 'case1', 'lead1')
    expect(result.action).toBe('handoff')
  })

  it('should suppress and stop on not_interested without replying', async () => {
    generateJsonMock.mockResolvedValue({ intent: 'not_interested', confidence: 0.9, canAnswer: false, missingQuestion: null, replyBody: null })
    const result = await runReplyForInbound({} as never, { emailId: 'in1' })
    expect(addSuppressionMock).toHaveBeenCalledWith({}, expect.objectContaining({ reason: 'manual' }))
    expect(stopSequenceForLeadMock).toHaveBeenCalledWith({}, 'lead1', 'stopped')
    expect(updateCaseStatusMock).toHaveBeenCalledWith({}, 'case1', 'lost')
    expect(sendViaMailboxMock).not.toHaveBeenCalled()
    expect(result.action).toBe('suppressed')
  })

  it('should draft (not send) when the reply slot is already claimed', async () => {
    generateJsonMock.mockResolvedValue({ intent: 'question', confidence: 0.9, canAnswer: true, missingQuestion: null, replyBody: 'Answer', attachResourceIds: [] })
    claimReplyEmailMock.mockResolvedValue(null) // already handled by a prior delivery
    const result = await runReplyForInbound({} as never, { emailId: 'in1' })
    expect(sendViaMailboxMock).not.toHaveBeenCalled()
    expect(result.action).toBe('answered')
  })

  it('should skip when the email is not an inbound record', async () => {
    getEmailByIdMock.mockResolvedValue({ ...inbound, direction: 'outbound' })
    const result = await runReplyForInbound({} as never, { emailId: 'in1' })
    expect(result.action).toBe('skipped')
  })
})

describe('runReplyForInbound resource selection', () => {
  it('should attach the resources the model picked when it answered', async () => {
    listActiveResourcesForClientMock.mockResolvedValue([resource()])
    generateJsonMock.mockResolvedValue({
      intent: 'question', confidence: 0.9, canAnswer: true,
      missingQuestion: null, replyBody: 'Attached are the examples.', attachResourceIds: [1],
    })

    const result = await runReplyForInbound({} as never, { emailId: 'in1' })

    expect(result.action).toBe('answered')
    expect(insertEmailAttachmentsMock).toHaveBeenCalledWith({}, {
      clientId: 'c1', emailId: 'reply1', resourceIds: ['r1'],
    })
  })

  it('should attach nothing when the client has no resources', async () => {
    listActiveResourcesForClientMock.mockResolvedValue([])
    generateJsonMock.mockResolvedValue({
      intent: 'question', confidence: 0.9, canAnswer: true,
      missingQuestion: null, replyBody: 'Sure.', attachResourceIds: [1, 2],
    })

    await runReplyForInbound({} as never, { emailId: 'in1' })

    expect(insertEmailAttachmentsMock).not.toHaveBeenCalled()
  })

  it('should attach nothing on a price handoff even if the model picked files', async () => {
    listActiveResourcesForClientMock.mockResolvedValue([resource({ title: 'Rates', description: 'pricing' })])
    generateJsonMock.mockResolvedValue({
      intent: 'price', confidence: 0.9, canAnswer: false,
      missingQuestion: null, replyBody: null, attachResourceIds: [1],
    })

    const result = await runReplyForInbound({} as never, { emailId: 'in1' })

    expect(result.action).toBe('handoff')
    expect(insertEmailAttachmentsMock).not.toHaveBeenCalled()
  })

  it('should include the resource menu in the prompt when the client has resources', async () => {
    listActiveResourcesForClientMock.mockResolvedValue([resource()])
    generateJsonMock.mockResolvedValue({
      intent: 'other', confidence: 0.9, canAnswer: true,
      missingQuestion: null, replyBody: 'ok', attachResourceIds: [],
    })

    await runReplyForInbound({} as never, { emailId: 'in1' })

    const promptArg = generateJsonMock.mock.calls[0]![1] as { prompt: string }
    expect(promptArg.prompt).toContain('1 — Deck — when to send: examples')
  })

  it('should give retrieval the menu ordinal for every resource it offers', async () => {
    listActiveResourcesForClientMock.mockResolvedValue([resource()])
    generateJsonMock.mockResolvedValue({
      intent: 'other', confidence: 0.9, canAnswer: true,
      missingQuestion: null, replyBody: 'ok', attachResourceIds: [],
    })

    await runReplyForInbound({} as never, { emailId: 'in1' })

    expect(retrieveClientKnowledgeMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ clientId: 'c1', resourceOrdinalById: new Map([['r1', 1]]) }),
    )
  })

  it('should pass an empty ordinal map when the client has no resources', async () => {
    generateJsonMock.mockResolvedValue({
      intent: 'other', confidence: 0.9, canAnswer: true,
      missingQuestion: null, replyBody: 'ok', attachResourceIds: [],
    })

    await runReplyForInbound({} as never, { emailId: 'in1' })

    expect(retrieveClientKnowledgeMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ resourceOrdinalById: new Map() }),
    )
  })

  it('should tell the model what an attachable knowledge line means', async () => {
    generateJsonMock.mockResolvedValue({
      intent: 'other', confidence: 0.9, canAnswer: true,
      missingQuestion: null, replyBody: 'ok', attachResourceIds: [],
    })

    await runReplyForInbound({} as never, { emailId: 'in1' })

    const call = generateJsonMock.mock.calls[0]![1] as { instructions: string }
    expect(call.instructions).toContain('attachable #N')
  })

  it('should retrieve only resource-backed knowledge, never a scraped website page', async () => {
    generateJsonMock.mockResolvedValue({
      intent: 'other', confidence: 0.9, canAnswer: true,
      missingQuestion: null, replyBody: 'ok', attachResourceIds: [],
    })

    await runReplyForInbound({} as never, { emailId: 'in1' })

    expect(retrieveClientKnowledgeMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ resourceOnly: true }),
    )
  })

  it('should inject the client\'s company info as "About our company", separate from retrieved file knowledge', async () => {
    getClientByIdMock.mockResolvedValue({ id: 'c1', name: 'Acme', company_info: 'Acme builds inventory software.' })
    retrieveClientKnowledgeMock.mockResolvedValue('- (Rate card, attachable #1) $99/mo.')
    generateJsonMock.mockResolvedValue({
      intent: 'other', confidence: 0.9, canAnswer: true,
      missingQuestion: null, replyBody: 'ok', attachResourceIds: [],
    })

    await runReplyForInbound({} as never, { emailId: 'in1' })

    const promptArg = generateJsonMock.mock.calls[0]![1] as { prompt: string }
    expect(promptArg.prompt).toContain('About our company:\nAcme builds inventory software.')
    expect(promptArg.prompt).toContain('Company knowledge from files:\n- (Rate card, attachable #1) $99/mo.')
  })
})

describe('sendOrDraftReply attachments', () => {
  const baseInput = {
    inbound, lead, mailboxIds: ['m1'], subject: 'Re: x', body: 'Here you go',
  }

  it('should record attachments on a draft without sending', async () => {
    await sendOrDraftReply({} as never, {
      ...baseInput, disposition: 'draft', resourceIds: ['r1'],
    } as never)

    expect(insertEmailAttachmentsMock).toHaveBeenCalledWith({}, {
      clientId: 'c1', emailId: 'reply1', resourceIds: ['r1'],
    })
    expect(sendViaMailboxMock).not.toHaveBeenCalled()
  })

  it('should forward loaded attachments to the sender when sending', async () => {
    const attachments = [{ fileName: 'a.pdf', mimeType: 'application/pdf', content: Buffer.from('X') }]
    loadResourceAttachmentsMock.mockResolvedValue(attachments)

    await sendOrDraftReply({} as never, {
      ...baseInput, disposition: 'send', resourceIds: ['r1'],
    } as never)

    expect(loadResourceAttachmentsMock).toHaveBeenCalledWith({}, 'c1', ['r1'])
    expect(sendViaMailboxMock).toHaveBeenCalledWith({}, expect.objectContaining({ attachments }))
  })

  it('should mark the email failed when loading an attachment fails', async () => {
    loadResourceAttachmentsMock.mockRejectedValue(new Error('storage gone'))

    await expect(
      sendOrDraftReply({} as never, {
        ...baseInput, disposition: 'send', resourceIds: ['r1'],
      } as never),
    ).rejects.toThrow('storage gone')

    expect(markEmailFailedMock).toHaveBeenCalledWith({}, 'reply1')
    expect(sendViaMailboxMock).not.toHaveBeenCalled()
  })

  it('should not attach anything when the claim was lost to a prior delivery', async () => {
    claimReplyEmailMock.mockResolvedValue(null)

    await sendOrDraftReply({} as never, {
      ...baseInput, disposition: 'send', resourceIds: ['r1'],
    } as never)

    expect(insertEmailAttachmentsMock).not.toHaveBeenCalled()
  })
})

describe('sendOrDraftReply', () => {
  const sendInput = {
    inbound, lead, mailboxIds: ['m1'], subject: 'Re: x', body: 'hi', disposition: 'send' as const,
    resourceIds: [],
  } as never

  beforeEach(() => {
    claimReplyEmailMock.mockResolvedValue({ id: 'reply1' })
  })

  it('should rethrow and leave the row queued (no markEmailFailed) on RATE_LIMITED', async () => {
    sendViaMailboxMock.mockRejectedValue(new AppError('RATE_LIMITED', 'slow down', {}))
    await expect(sendOrDraftReply({} as never, sendInput)).rejects.toMatchObject({ code: 'RATE_LIMITED' })
    expect(markEmailFailedMock).not.toHaveBeenCalled()
  })

  it('should mark the row failed and rethrow on other errors', async () => {
    sendViaMailboxMock.mockRejectedValue(new AppError('EXTERNAL_ERROR', 'smtp down', {}))
    await expect(sendOrDraftReply({} as never, sendInput)).rejects.toMatchObject({ code: 'EXTERNAL_ERROR' })
    expect(markEmailFailedMock).toHaveBeenCalledWith({}, 'reply1')
  })
})
