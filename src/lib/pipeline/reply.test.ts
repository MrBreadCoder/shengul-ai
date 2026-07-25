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

vi.mock('@/lib/db/emails', () => ({
  getEmailById: (...a: unknown[]) => getEmailByIdMock(...a),
  listThreadEmails: (...a: unknown[]) => listThreadEmailsMock(...a),
  claimReplyEmail: (...a: unknown[]) => claimReplyEmailMock(...a),
  markEmailSent: (...a: unknown[]) => markEmailSentMock(...a),
  markEmailFailed: (...a: unknown[]) => markEmailFailedMock(...a),
}))
vi.mock('@/lib/db/leads', () => ({ getLeadById: (...a: unknown[]) => getLeadByIdMock(...a) }))
vi.mock('@/lib/db/campaigns', () => ({ getCampaignForCase: (...a: unknown[]) => getCampaignForCaseMock(...a) }))
vi.mock('@/lib/db/case-knowledge', () => ({ listKnowledgeForCase: (...a: unknown[]) => listKnowledgeMock(...a) }))
vi.mock('@/lib/db/suppressions', () => ({ addSuppression: (...a: unknown[]) => addSuppressionMock(...a) }))
vi.mock('@/lib/db/sequences', () => ({ stopSequenceForLead: (...a: unknown[]) => stopSequenceForLeadMock(...a) }))
vi.mock('@/lib/db/cases', () => ({ updateCaseStatus: (...a: unknown[]) => updateCaseStatusMock(...a) }))
vi.mock('@/lib/db/knowledge-requests', () => ({ createKnowledgeRequest: (...a: unknown[]) => createKnowledgeRequestMock(...a) }))
vi.mock('@/lib/mailbox/sender', () => ({ sendViaMailbox: (...a: unknown[]) => sendViaMailboxMock(...a) }))
vi.mock('@/lib/llm/client', () => ({ generateJson: (...a: unknown[]) => generateJsonMock(...a) }))
vi.mock('@/lib/events/log-event', () => ({ logEventSafe: (...a: unknown[]) => logEventMock(...a) }))
vi.mock('@/lib/knowledge/client-context', () => ({ retrieveClientKnowledge: vi.fn().mockResolvedValue('') }))
vi.mock('@/lib/pipeline/collision-notify', () => ({
  triggerCollisionNotice: (...a: unknown[]) => triggerCollisionNoticeMock(...a),
}))

import { runReplyForInbound, replyDisposition, sendOrDraftReply } from './reply'

const inbound = {
  id: 'in1', client_id: 'c1', case_id: 'case1', lead_id: 'lead1',
  direction: 'inbound', thread_id: 't1', provider_message_id: 'g1', body: 'Hi',
}
const lead = { id: 'lead1', email: 'jane@acme.com' }
const campaign = { mailbox_ids: ['m1'], value_prop: 'v', booking_link: 'https://cal.com/x', reply_mode: 'auto_send' }

beforeEach(() => {
  for (const m of [getEmailByIdMock, getLeadByIdMock, getCampaignForCaseMock, listThreadEmailsMock, listKnowledgeMock,
    claimReplyEmailMock, markEmailSentMock, markEmailFailedMock, addSuppressionMock, stopSequenceForLeadMock,
    updateCaseStatusMock, createKnowledgeRequestMock, sendViaMailboxMock, generateJsonMock, logEventMock,
    triggerCollisionNoticeMock]) m.mockReset()
  getEmailByIdMock.mockResolvedValue(inbound)
  getLeadByIdMock.mockResolvedValue(lead)
  getCampaignForCaseMock.mockResolvedValue(campaign)
  listThreadEmailsMock.mockResolvedValue([{ direction: 'outbound', subject: 'Quick idea', provider_message_id: 'out1' }])
  listKnowledgeMock.mockResolvedValue([])
  claimReplyEmailMock.mockResolvedValue({ id: 'reply1' })
  sendViaMailboxMock.mockResolvedValue({ mailboxId: 'm1', providerMessageId: 'p2', threadId: 't1' })
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
    generateJsonMock.mockResolvedValue({ intent: 'question', confidence: 0.9, canAnswer: true, missingQuestion: null, replyBody: 'Here is the answer.' })
    const result = await runReplyForInbound({} as never, { emailId: 'in1' })
    expect(sendViaMailboxMock).toHaveBeenCalled()
    expect(updateCaseStatusMock).toHaveBeenCalledWith({}, 'case1', 'in_conversation')
    expect(result.action).toBe('answered')
  })

  it('should classify the reply with medium thinking', async () => {
    generateJsonMock.mockResolvedValue({ intent: 'question', confidence: 0.9, canAnswer: true, missingQuestion: null, replyBody: 'Here is the answer.' })
    await runReplyForInbound({} as never, { emailId: 'in1' })
    expect(generateJsonMock).toHaveBeenCalledWith(
      expect.objectContaining({ actor: 'reply_agent' }),
      expect.objectContaining({ thinkingLevel: 'medium' }),
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
    generateJsonMock.mockResolvedValue({ intent: 'question', confidence: 0.9, canAnswer: true, missingQuestion: null, replyBody: 'Answer' })
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

describe('sendOrDraftReply', () => {
  const sendInput = {
    inbound, lead, mailboxIds: ['m1'], subject: 'Re: x', body: 'hi', disposition: 'send' as const,
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
