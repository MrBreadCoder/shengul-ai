import { describe, it, expect, vi, beforeEach } from 'vitest'

const getSequenceByIdMock = vi.fn()
const hasInboundReplyMock = vi.fn()
const stopSequenceMock = vi.fn()
const advanceSequenceMock = vi.fn()
const getLeadByIdMock = vi.fn()
const listThreadEmailsMock = vi.fn()
const claimOutboundEmailMock = vi.fn()
const markEmailSentMock = vi.fn()
const markEmailFailedMock = vi.fn()
const isSuppressedMock = vi.fn()
const sendViaMailboxMock = vi.fn()
const generateTextMock = vi.fn()
const getCampaignForCaseMock = vi.fn()
const updateCaseStatusMock = vi.fn()
const publishDelayMock = vi.fn()
const logEventMock = vi.fn()

vi.mock('@/lib/db/sequences', () => ({
  getSequenceById: (...a: unknown[]) => getSequenceByIdMock(...a),
  stopSequence: (...a: unknown[]) => stopSequenceMock(...a),
  advanceSequence: (...a: unknown[]) => advanceSequenceMock(...a),
}))
vi.mock('@/lib/db/emails', () => ({
  hasInboundReply: (...a: unknown[]) => hasInboundReplyMock(...a),
  listThreadEmails: (...a: unknown[]) => listThreadEmailsMock(...a),
  claimOutboundEmail: (...a: unknown[]) => claimOutboundEmailMock(...a),
  markEmailSent: (...a: unknown[]) => markEmailSentMock(...a),
  markEmailFailed: (...a: unknown[]) => markEmailFailedMock(...a),
}))
vi.mock('@/lib/db/leads', () => ({ getLeadById: (...a: unknown[]) => getLeadByIdMock(...a) }))
vi.mock('@/lib/db/suppressions', () => ({ isSuppressed: (...a: unknown[]) => isSuppressedMock(...a) }))
vi.mock('@/lib/db/campaigns', () => ({ getCampaignForCase: (...a: unknown[]) => getCampaignForCaseMock(...a) }))
vi.mock('@/lib/db/cases', () => ({ updateCaseStatus: (...a: unknown[]) => updateCaseStatusMock(...a) }))
vi.mock('@/lib/mailbox/sender', () => ({ sendViaMailbox: (...a: unknown[]) => sendViaMailboxMock(...a) }))
vi.mock('@/lib/llm/client', () => ({ generateText: (...a: unknown[]) => generateTextMock(...a) }))
vi.mock('@/lib/qstash/client', () => ({ publishJsonWithDelay: (...a: unknown[]) => publishDelayMock(...a) }))
vi.mock('@/lib/events/log-event', () => ({ logEvent: (...a: unknown[]) => logEventMock(...a), logEventSafe: (...a: unknown[]) => logEventMock(...a) }))
vi.mock('@/lib/knowledge/client-context', () => ({ retrieveClientKnowledge: vi.fn().mockResolvedValue('') }))

import { runFollowupStep } from './followup'

const sequence = { id: 'seq1', client_id: 'c1', case_id: 'case1', lead_id: 'lead1', current_step: 0, state: 'active' }
const lead = { id: 'lead1', email: 'jane@acme.com', full_name: 'Jane', title: 'CTO' }

beforeEach(() => {
  for (const m of [getSequenceByIdMock, hasInboundReplyMock, stopSequenceMock, advanceSequenceMock,
    getLeadByIdMock, listThreadEmailsMock, claimOutboundEmailMock, markEmailSentMock, markEmailFailedMock,
    isSuppressedMock, sendViaMailboxMock, generateTextMock, getCampaignForCaseMock, updateCaseStatusMock,
    publishDelayMock, logEventMock]) m.mockReset()
  getSequenceByIdMock.mockResolvedValue(sequence)
  hasInboundReplyMock.mockResolvedValue(false)
  getLeadByIdMock.mockResolvedValue(lead)
  isSuppressedMock.mockResolvedValue(false)
  listThreadEmailsMock.mockResolvedValue([
    { direction: 'outbound', subject: 'Quick idea', body: 'Hi', thread_id: 'thr1', provider_message_id: '<a@mail>' },
  ])
  getCampaignForCaseMock.mockResolvedValue({ mailbox_ids: ['m1'], value_prop: 'v', status: 'active' })
  generateTextMock.mockResolvedValue('Just following up, Jane.')
})

describe('runFollowupStep', () => {
  it('should send the nudge, advance the step, and enqueue the next follow-up', async () => {
    claimOutboundEmailMock.mockResolvedValue({ id: 'e2' })
    sendViaMailboxMock.mockResolvedValue({ mailboxId: 'm1', providerMessageId: '<b@mail>', threadId: 'thr1' })
    publishDelayMock.mockResolvedValue('qmsg2')
    const result = await runFollowupStep({} as never, { sequenceId: 'seq1', step: 1 })
    expect(result.action).toBe('sent')
    expect(advanceSequenceMock).toHaveBeenCalled()
    expect(publishDelayMock).toHaveBeenCalled() // step 2 enqueued
  })

  it('should complete the sequence when a reply exists', async () => {
    hasInboundReplyMock.mockResolvedValue(true)
    const result = await runFollowupStep({} as never, { sequenceId: 'seq1', step: 1 })
    expect(result.action).toBe('completed')
    expect(stopSequenceMock).toHaveBeenCalledWith(expect.anything(), 'seq1', 'completed')
    expect(sendViaMailboxMock).not.toHaveBeenCalled()
  })

  it('should stop the sequence and mark the case dead after the final step', async () => {
    getSequenceByIdMock.mockResolvedValue({ ...sequence, current_step: 2 }) // sitting at step 2, driving step 3
    claimOutboundEmailMock.mockResolvedValue({ id: 'e4' })
    sendViaMailboxMock.mockResolvedValue({ mailboxId: 'm1', providerMessageId: '<d@mail>', threadId: 'thr1' })
    const result = await runFollowupStep({} as never, { sequenceId: 'seq1', step: 3 })
    expect(result.action).toBe('stopped')
    expect(stopSequenceMock).toHaveBeenCalledWith(expect.anything(), 'seq1', 'stopped')
    expect(updateCaseStatusMock).toHaveBeenCalledWith(expect.anything(), 'case1', 'dead')
    expect(publishDelayMock).not.toHaveBeenCalled() // nothing after step 3
  })

  it('should skip when the sequence step no longer matches (stale/duplicate delivery)', async () => {
    getSequenceByIdMock.mockResolvedValue({ ...sequence, current_step: 2 }) // already past step 1
    const result = await runFollowupStep({} as never, { sequenceId: 'seq1', step: 1 })
    expect(result.action).toBe('skipped')
    expect(sendViaMailboxMock).not.toHaveBeenCalled()
  })

  it('should mark the email failed and return skipped when every mailbox is rate limited', async () => {
    const { AppError } = await import('@/lib/errors/app-error')
    claimOutboundEmailMock.mockResolvedValue({ id: 'e2' })
    sendViaMailboxMock.mockRejectedValue(new AppError('RATE_LIMITED', 'no mailbox available'))
    const result = await runFollowupStep({} as never, { sequenceId: 'seq1', step: 1 })
    expect(result.action).toBe('skipped')
    expect(markEmailFailedMock).toHaveBeenCalledWith(expect.anything(), 'e2')
    expect(markEmailSentMock).not.toHaveBeenCalled()
  })

  it('should not mark the email failed when the send succeeded but markEmailSent throws', async () => {
    claimOutboundEmailMock.mockResolvedValue({ id: 'e2' })
    sendViaMailboxMock.mockResolvedValue({ mailboxId: 'm1', providerMessageId: '<b@mail>', threadId: 'thr1' })
    markEmailSentMock.mockRejectedValue(new Error('db unreachable'))

    await expect(runFollowupStep({} as never, { sequenceId: 'seq1', step: 1 })).rejects.toThrow('db unreachable')
    expect(markEmailFailedMock).not.toHaveBeenCalled()
  })

  it('should skip and reschedule the same step when the campaign is not active', async () => {
    getCampaignForCaseMock.mockResolvedValue({ mailbox_ids: ['m1'], value_prop: 'v', status: 'paused' })
    publishDelayMock.mockResolvedValue('msg-retry-1')

    const result = await runFollowupStep({} as never, { sequenceId: 'seq1', step: 1 })

    expect(result).toEqual({ sequenceId: 'seq1', action: 'skipped' })
    expect(generateTextMock).not.toHaveBeenCalled()
    expect(sendViaMailboxMock).not.toHaveBeenCalled()
    expect(publishDelayMock).toHaveBeenCalledWith(
      '/api/pipeline/followup',
      { sequenceId: 'seq1', step: 1 },
      expect.any(Number),
    )
  })
})
