import { describe, it, expect, vi, beforeEach } from 'vitest'

const getSequenceByIdMock = vi.fn()
const consumeFollowupSkipMock = vi.fn()
const hasInboundReplyMock = vi.fn()
const stopSequenceMock = vi.fn()
const advanceSequenceMock = vi.fn()
const getLeadByIdMock = vi.fn()
const getClientByIdMock = vi.fn()
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
const enqueueCrmSyncMock = vi.fn()
const createSequenceMock = vi.fn()

vi.mock('@/lib/db/sequences', () => ({
  getSequenceById: (...a: unknown[]) => getSequenceByIdMock(...a),
  createSequence: (...a: unknown[]) => createSequenceMock(...a),
  stopSequence: (...a: unknown[]) => stopSequenceMock(...a),
  advanceSequence: (...a: unknown[]) => advanceSequenceMock(...a),
  consumeFollowupSkip: (...a: unknown[]) => consumeFollowupSkipMock(...a),
}))
vi.mock('@/lib/db/emails', () => ({
  hasInboundReply: (...a: unknown[]) => hasInboundReplyMock(...a),
  listThreadEmails: (...a: unknown[]) => listThreadEmailsMock(...a),
  claimOutboundEmail: (...a: unknown[]) => claimOutboundEmailMock(...a),
  markEmailSent: (...a: unknown[]) => markEmailSentMock(...a),
  markEmailFailed: (...a: unknown[]) => markEmailFailedMock(...a),
}))
vi.mock('@/lib/db/leads', () => ({ getLeadById: (...a: unknown[]) => getLeadByIdMock(...a) }))
vi.mock('@/lib/db/clients', () => ({ getClientById: (...a: unknown[]) => getClientByIdMock(...a) }))
vi.mock('@/lib/db/suppressions', () => ({ isSuppressed: (...a: unknown[]) => isSuppressedMock(...a) }))
vi.mock('@/lib/db/campaigns', () => ({ getCampaignForCase: (...a: unknown[]) => getCampaignForCaseMock(...a) }))
vi.mock('@/lib/db/cases', () => ({ updateCaseStatus: (...a: unknown[]) => updateCaseStatusMock(...a) }))
vi.mock('@/lib/mailbox/sender', () => ({ sendViaMailbox: (...a: unknown[]) => sendViaMailboxMock(...a) }))
vi.mock('@/lib/llm/client', () => ({
  generateText: (...a: unknown[]) => generateTextMock(...a),
  EMAIL_WRITER_MODEL_ID: 'gemini-3.7-flash',
}))
vi.mock('@/lib/qstash/client', () => ({ publishJsonWithDelay: (...a: unknown[]) => publishDelayMock(...a) }))
vi.mock('@/lib/events/log-event', () => ({ logEvent: (...a: unknown[]) => logEventMock(...a), logEventSafe: (...a: unknown[]) => logEventMock(...a) }))
vi.mock('@/lib/crm/sync', () => ({ enqueueCrmSync: (...a: unknown[]) => enqueueCrmSyncMock(...a) }))

import { runFollowupStep, scheduleFirstFollowup } from './followup'

const DAY_SECONDS = 86_400

// 3/7/14 default cadence, snapshotted onto the sequence — matches every
// existing sequence row until a client or per-lead edit changes it.
const sequence = {
  id: 'seq1', client_id: 'c1', case_id: 'case1', lead_id: 'lead1',
  current_step: 0, state: 'active', followup_delays_days: [3, 7, 14],
}
const lead = { id: 'lead1', email: 'jane@acme.com', full_name: 'Jane', title: 'CTO' }

beforeEach(() => {
  for (const m of [getSequenceByIdMock, hasInboundReplyMock, stopSequenceMock, advanceSequenceMock,
    getLeadByIdMock, getClientByIdMock, listThreadEmailsMock, claimOutboundEmailMock, markEmailSentMock,
    markEmailFailedMock, isSuppressedMock, sendViaMailboxMock, generateTextMock, getCampaignForCaseMock,
    updateCaseStatusMock, publishDelayMock, logEventMock, consumeFollowupSkipMock, enqueueCrmSyncMock,
    createSequenceMock]) m.mockReset()
  getSequenceByIdMock.mockResolvedValue({ ...sequence, skip_next_step: false })
  consumeFollowupSkipMock.mockResolvedValue(false)
  hasInboundReplyMock.mockResolvedValue(false)
  getLeadByIdMock.mockResolvedValue(lead)
  getClientByIdMock.mockResolvedValue({ id: 'c1', followup_delays_days: [3, 7, 14], name: 'Acme', domain: null, phone: null, address: null, signature_name: null, signature_title: null, company_info: null })
  isSuppressedMock.mockResolvedValue(false)
  listThreadEmailsMock.mockResolvedValue([
    { direction: 'outbound', subject: 'Quick idea', body: 'Hi', thread_id: 'thr1', provider_message_id: '<a@mail>' },
  ])
  getCampaignForCaseMock.mockResolvedValue({
    mailbox_ids: ['m1'], value_prop: 'v', status: 'active',
    signature_name: null, signature_title: null, phone: null, address: null,
  })
  generateTextMock.mockResolvedValue('Just following up, Jane.')
})

describe('scheduleFirstFollowup', () => {
  it('should snapshot the client default cadence onto the new sequence and schedule step 1', async () => {
    createSequenceMock.mockResolvedValue({ id: 'seq1' })
    publishDelayMock.mockResolvedValue('qmsg1')

    await scheduleFirstFollowup({} as never, { clientId: 'c1', caseId: 'case1', leadId: 'lead1' })

    expect(createSequenceMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      client_id: 'c1', case_id: 'case1', lead_id: 'lead1', followup_delays_days: [3, 7, 14],
    }))
    expect(publishDelayMock).toHaveBeenCalledWith(
      '/api/pipeline/followup', { sequenceId: 'seq1', step: 1 }, 3 * DAY_SECONDS,
    )
    expect(advanceSequenceMock).toHaveBeenCalledWith(expect.anything(), 'seq1', {
      currentStep: 0, nextActionAt: expect.any(String), qstashMessageId: 'qmsg1',
    })
  })

  it('should fall back to the default cadence when the client lookup returns null', async () => {
    getClientByIdMock.mockResolvedValue(null)
    createSequenceMock.mockResolvedValue({ id: 'seq1' })
    publishDelayMock.mockResolvedValue('qmsg1')

    await scheduleFirstFollowup({} as never, { clientId: 'c1', caseId: 'case1', leadId: 'lead1' })

    expect(createSequenceMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      followup_delays_days: [3, 7, 14],
    }))
  })

  it('should no-op when a sequence already exists for the lead', async () => {
    createSequenceMock.mockResolvedValue(null)
    await scheduleFirstFollowup({} as never, { clientId: 'c1', caseId: 'case1', leadId: 'lead1' })
    expect(publishDelayMock).not.toHaveBeenCalled()
  })

  it('should use a client cadence other than the default', async () => {
    getClientByIdMock.mockResolvedValue({ id: 'c1', followup_delays_days: [1, 4] })
    createSequenceMock.mockResolvedValue({ id: 'seq1' })
    publishDelayMock.mockResolvedValue('qmsg1')

    await scheduleFirstFollowup({} as never, { clientId: 'c1', caseId: 'case1', leadId: 'lead1' })

    expect(createSequenceMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      followup_delays_days: [1, 4],
    }))
    expect(publishDelayMock).toHaveBeenCalledWith('/api/pipeline/followup', { sequenceId: 'seq1', step: 1 }, 1 * DAY_SECONDS)
  })
})

describe('runFollowupStep', () => {
  it('should send the nudge, advance the step, and enqueue the next follow-up', async () => {
    claimOutboundEmailMock.mockResolvedValue({ id: 'e2' })
    sendViaMailboxMock.mockResolvedValue({ mailboxId: 'm1', providerMessageId: '<b@mail>', threadId: 'thr1' })
    publishDelayMock.mockResolvedValue('qmsg2')
    const result = await runFollowupStep({} as never, { sequenceId: 'seq1', step: 1 })
    expect(result.action).toBe('sent')
    expect(advanceSequenceMock).toHaveBeenCalledWith(expect.anything(), 'seq1', {
      currentStep: 1, nextActionAt: expect.any(String), qstashMessageId: 'qmsg2',
    })
    expect(publishDelayMock).toHaveBeenCalledWith(
      '/api/pipeline/followup', { sequenceId: 'seq1', step: 2 }, 7 * DAY_SECONDS,
    )
  })

  it('should generate the nudge with the gemini-3.7-flash override', async () => {
    claimOutboundEmailMock.mockResolvedValue({ id: 'e2' })
    sendViaMailboxMock.mockResolvedValue({ mailboxId: 'm1', providerMessageId: '<b@mail>', threadId: 'thr1' })
    publishDelayMock.mockResolvedValue('qmsg2')
    await runFollowupStep({} as never, { sequenceId: 'seq1', step: 1 })
    expect(generateTextMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ modelId: 'gemini-3.7-flash' }),
    )
  })

  it('should complete the sequence when a reply exists', async () => {
    hasInboundReplyMock.mockResolvedValue(true)
    const result = await runFollowupStep({} as never, { sequenceId: 'seq1', step: 1 })
    expect(result.action).toBe('completed')
    expect(stopSequenceMock).toHaveBeenCalledWith(expect.anything(), 'seq1', 'completed')
    expect(sendViaMailboxMock).not.toHaveBeenCalled()
  })

  it('should stop the sequence and mark the case dead after the final step', async () => {
    getSequenceByIdMock.mockResolvedValue({ ...sequence, current_step: 2 }) // sitting at step 2, driving step 3 (of 3)
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

  it('should skip without sending when a shrunk cadence no longer has this step', async () => {
    // Cadence was 3 steps when step 3 was enqueued; a client edit since then
    // shrank it to 1. QStash still delivers the old step-3 message on its
    // original timer — it must no-op, not send an unwanted extra nudge.
    getSequenceByIdMock.mockResolvedValue({ ...sequence, current_step: 2, followup_delays_days: [3] })
    const result = await runFollowupStep({} as never, { sequenceId: 'seq1', step: 3 })
    expect(result.action).toBe('skipped')
    expect(sendViaMailboxMock).not.toHaveBeenCalled()
    expect(generateTextMock).not.toHaveBeenCalled()
    expect(stopSequenceMock).not.toHaveBeenCalled()
    expect(publishDelayMock).not.toHaveBeenCalled()
  })

  it('should keep going past the old 3-step ceiling when the cadence was grown', async () => {
    getSequenceByIdMock.mockResolvedValue({ ...sequence, current_step: 2, followup_delays_days: [3, 7, 14, 21, 28] })
    claimOutboundEmailMock.mockResolvedValue({ id: 'e4' })
    sendViaMailboxMock.mockResolvedValue({ mailboxId: 'm1', providerMessageId: '<d@mail>', threadId: 'thr1' })
    publishDelayMock.mockResolvedValue('qmsg4')
    const result = await runFollowupStep({} as never, { sequenceId: 'seq1', step: 3 })
    expect(result.action).toBe('sent')
    expect(stopSequenceMock).not.toHaveBeenCalled()
    expect(publishDelayMock).toHaveBeenCalledWith(
      '/api/pipeline/followup', { sequenceId: 'seq1', step: 4 }, 21 * DAY_SECONDS,
    )
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

  it('should append the phone signature to the nudge body when the client has a phone on file', async () => {
    claimOutboundEmailMock.mockResolvedValue({ id: 'e2' })
    sendViaMailboxMock.mockResolvedValue({ mailboxId: 'm1', providerMessageId: '<b@mail>', threadId: 'thr1' })
    publishDelayMock.mockResolvedValue('qmsg2')
    getClientByIdMock.mockResolvedValue({
      id: 'c1', followup_delays_days: [3, 7, 14], name: 'Acme', domain: 'acme.com',
      phone: '+1 555 123 4567', address: null, signature_name: null, signature_title: null,
    })

    await runFollowupStep({} as never, { sequenceId: 'seq1', step: 1 })

    const expectedBody = 'Just following up, Jane.\n\nBest regards,\n\nAcme\n\n+1 555 123 4567\nacme.com'
    expect(claimOutboundEmailMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ body: expectedBody }))
    expect(sendViaMailboxMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ body: expectedBody }))
  })

  it('should not append a signature to the nudge when the client has no phone on file', async () => {
    claimOutboundEmailMock.mockResolvedValue({ id: 'e2' })
    sendViaMailboxMock.mockResolvedValue({ mailboxId: 'm1', providerMessageId: '<b@mail>', threadId: 'thr1' })
    publishDelayMock.mockResolvedValue('qmsg2')

    await runFollowupStep({} as never, { sequenceId: 'seq1', step: 1 })

    expect(claimOutboundEmailMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ body: 'Just following up, Jane.' }),
    )
  })

  it("should override the client's phone with the campaign's own phone override in the nudge", async () => {
    claimOutboundEmailMock.mockResolvedValue({ id: 'e2' })
    sendViaMailboxMock.mockResolvedValue({ mailboxId: 'm1', providerMessageId: '<b@mail>', threadId: 'thr1' })
    publishDelayMock.mockResolvedValue('qmsg2')
    getClientByIdMock.mockResolvedValue({
      id: 'c1', followup_delays_days: [3, 7, 14], name: 'Acme', domain: 'acme.com',
      phone: '+1 555 000 0000', address: null, signature_name: null, signature_title: null,
    })
    getCampaignForCaseMock.mockResolvedValue({
      mailbox_ids: ['m1'], value_prop: 'v', status: 'active',
      signature_name: null, signature_title: null, phone: '+1 555 999 9999', address: null,
    })

    await runFollowupStep({} as never, { sequenceId: 'seq1', step: 1 })

    const expectedBody = 'Just following up, Jane.\n\nBest regards,\n\nAcme\n\n+1 555 999 9999\nacme.com'
    expect(claimOutboundEmailMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ body: expectedBody }))
  })

  it('should inject the client\'s company info as "About our company" when set', async () => {
    claimOutboundEmailMock.mockResolvedValue({ id: 'e2' })
    sendViaMailboxMock.mockResolvedValue({ mailboxId: 'm1', providerMessageId: '<b@mail>', threadId: 'thr1' })
    publishDelayMock.mockResolvedValue('qmsg2')
    getClientByIdMock.mockResolvedValue({
      id: 'c1', followup_delays_days: [3, 7, 14], name: 'Acme', domain: null,
      phone: null, address: null, signature_name: null, signature_title: null,
      company_info: 'Acme builds inventory software for retailers.',
    })

    await runFollowupStep({} as never, { sequenceId: 'seq1', step: 1 })

    expect(generateTextMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ prompt: expect.stringContaining('About our company:\nAcme builds inventory software for retailers.') }),
    )
  })
})

describe('runFollowupStep — manual-send skip', () => {
  it('should send nothing, consume the flag and enqueue the next step', async () => {
    consumeFollowupSkipMock.mockResolvedValue(true)
    publishDelayMock.mockResolvedValue('qmsg-next')

    const result = await runFollowupStep({} as never, { sequenceId: 'seq1', step: 1 })

    expect(result.action).toBe('skipped')
    expect(sendViaMailboxMock).not.toHaveBeenCalled()
    expect(generateTextMock).not.toHaveBeenCalled()
    expect(consumeFollowupSkipMock).toHaveBeenCalledWith(expect.anything(), 'seq1')
    // Step 2 enqueued at the step-1 delay index (7 days).
    expect(publishDelayMock).toHaveBeenCalledWith(
      '/api/pipeline/followup',
      { sequenceId: 'seq1', step: 2 },
      7 * DAY_SECONDS,
    )
    expect(advanceSequenceMock).toHaveBeenCalledWith(expect.anything(), 'seq1', {
      currentStep: 1, nextActionAt: expect.any(String), qstashMessageId: 'qmsg-next',
    })
  })

  it('should not enqueue twice when another delivery already consumed the flag', async () => {
    consumeFollowupSkipMock.mockResolvedValue(false)

    const result = await runFollowupStep({} as never, { sequenceId: 'seq1', step: 1 })

    expect(result.action).toBe('skipped')
    expect(publishDelayMock).not.toHaveBeenCalled()
    expect(advanceSequenceMock).not.toHaveBeenCalled()
  })

  it('should stop the sequence on a skipped final step without killing the case', async () => {
    getSequenceByIdMock.mockResolvedValue({ ...sequence, current_step: 2 })
    consumeFollowupSkipMock.mockResolvedValue(true)

    const result = await runFollowupStep({} as never, { sequenceId: 'seq1', step: 3 })

    expect(result.action).toBe('skipped')
    expect(stopSequenceMock).toHaveBeenCalledWith(expect.anything(), 'seq1', 'stopped')
    expect(updateCaseStatusMock).not.toHaveBeenCalled()
    expect(publishDelayMock).not.toHaveBeenCalled()
  })

  it('should let an inbound reply win over a pending skip', async () => {
    consumeFollowupSkipMock.mockResolvedValue(true)
    hasInboundReplyMock.mockResolvedValue(true)

    const result = await runFollowupStep({} as never, { sequenceId: 'seq1', step: 1 })

    expect(result.action).toBe('completed')
    expect(consumeFollowupSkipMock).not.toHaveBeenCalled()
  })

  it('should postpone the skip while the campaign is paused', async () => {
    consumeFollowupSkipMock.mockResolvedValue(true)
    getCampaignForCaseMock.mockResolvedValue({ mailbox_ids: ['m1'], value_prop: 'v', status: 'paused' })
    publishDelayMock.mockResolvedValue('qmsg-retry')

    const result = await runFollowupStep({} as never, { sequenceId: 'seq1', step: 1 })

    expect(result.action).toBe('skipped')
    expect(consumeFollowupSkipMock).not.toHaveBeenCalled()
    // Same step re-queued, so the skip is still pending when the client resumes.
    expect(publishDelayMock).toHaveBeenCalledWith(
      '/api/pipeline/followup', { sequenceId: 'seq1', step: 1 }, expect.any(Number),
    )
  })

  it('should honor a skip requested after this run already loaded a stale sequence snapshot', async () => {
    // Regression test for the race this fix closes: the initial getSequenceById
    // read has skip_next_step: false, but a concurrent manual send flips the DB
    // flag before this run reaches the skip check. consumeFollowupSkip is the
    // atomic, DB-level source of truth here, not the in-memory `sequence` object.
    getSequenceByIdMock.mockResolvedValue({ ...sequence, skip_next_step: false })
    consumeFollowupSkipMock.mockResolvedValue(true)
    publishDelayMock.mockResolvedValue('qmsg-race')

    const result = await runFollowupStep({} as never, { sequenceId: 'seq1', step: 1 })

    expect(result.action).toBe('skipped')
    expect(sendViaMailboxMock).not.toHaveBeenCalled()
    expect(generateTextMock).not.toHaveBeenCalled()
  })
})
