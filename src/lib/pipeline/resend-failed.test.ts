import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AppError } from '@/lib/errors/app-error'

const listWaitingOutboundEmailsMock = vi.fn()
const claimWaitingOutboundEmailMock = vi.fn()
const markEmailSentMock = vi.fn()
const markEmailFailedMock = vi.fn()
const markEmailWaitingMock = vi.fn()
const hasInboundReplyMock = vi.fn()
const listThreadEmailsMock = vi.fn()
const getLeadByIdMock = vi.fn()
const getCaseByIdMock = vi.fn()
const updateLeadStageMock = vi.fn()
const recomputeCaseStatusMock = vi.fn()
const getCampaignForCaseMock = vi.fn()
const sendViaMailboxMock = vi.fn()
const scheduleFirstFollowupMock = vi.fn()
const enqueueCrmSyncMock = vi.fn()
const logEventSafeMock = vi.fn()
const getSequenceByLeadIdMock = vi.fn()
const advanceSequenceMock = vi.fn()
const stopSequenceMock = vi.fn()
const publishDelayMock = vi.fn()

vi.mock('@/lib/db/emails', () => ({
  listWaitingOutboundEmails: (...a: unknown[]) => listWaitingOutboundEmailsMock(...a),
  claimWaitingOutboundEmail: (...a: unknown[]) => claimWaitingOutboundEmailMock(...a),
  markEmailSent: (...a: unknown[]) => markEmailSentMock(...a),
  markEmailFailed: (...a: unknown[]) => markEmailFailedMock(...a),
  markEmailWaiting: (...a: unknown[]) => markEmailWaitingMock(...a),
  hasInboundReply: (...a: unknown[]) => hasInboundReplyMock(...a),
  listThreadEmails: (...a: unknown[]) => listThreadEmailsMock(...a),
}))
vi.mock('@/lib/db/leads', () => ({
  getLeadById: (...a: unknown[]) => getLeadByIdMock(...a),
  updateLeadStage: (...a: unknown[]) => updateLeadStageMock(...a),
}))
const mockCrmSyncStatuses = ['contacted', 'in_conversation', 'hot_handoff', 'won', 'lost', 'dead']
vi.mock('@/lib/db/cases', () => ({
  getCaseById: (...a: unknown[]) => getCaseByIdMock(...a),
  recomputeCaseStatus: (...a: unknown[]) => recomputeCaseStatusMock(...a),
  isCrmSyncStatus: (status: string) => mockCrmSyncStatuses.includes(status),
}))
vi.mock('@/lib/db/campaigns', () => ({ getCampaignForCase: (...a: unknown[]) => getCampaignForCaseMock(...a) }))
vi.mock('@/lib/mailbox/sender', () => ({ sendViaMailbox: (...a: unknown[]) => sendViaMailboxMock(...a) }))
vi.mock('./followup', () => ({
  FIRST_TOUCH_STEP: 0,
  DAY_SECONDS: 86_400,
  scheduleFirstFollowup: (...a: unknown[]) => scheduleFirstFollowupMock(...a),
}))
vi.mock('@/lib/db/sequences', () => ({
  getSequenceByLeadId: (...a: unknown[]) => getSequenceByLeadIdMock(...a),
  advanceSequence: (...a: unknown[]) => advanceSequenceMock(...a),
  stopSequence: (...a: unknown[]) => stopSequenceMock(...a),
}))
vi.mock('@/lib/qstash/client', () => ({ publishJsonWithDelay: (...a: unknown[]) => publishDelayMock(...a) }))
vi.mock('@/lib/crm/sync', () => ({ enqueueCrmSync: (...a: unknown[]) => enqueueCrmSyncMock(...a) }))
vi.mock('@/lib/events/log-event', () => ({ logEventSafe: (...a: unknown[]) => logEventSafeMock(...a) }))

import { sweepFailedFirstTouch } from './resend-failed'

const SUPABASE = {} as never

function waitingEmail(overrides: Record<string, unknown> = {}) {
  return {
    id: 'e1', client_id: 'c1', case_id: 'case1', lead_id: 'lead1', thread_id: null,
    subject: 'Hi there', body: 'Body text', status: 'waiting', direction: 'outbound', sequence_step: 0,
    ...overrides,
  }
}

beforeEach(() => {
  for (const m of [
    listWaitingOutboundEmailsMock, claimWaitingOutboundEmailMock, markEmailSentMock, markEmailFailedMock,
    markEmailWaitingMock, hasInboundReplyMock, listThreadEmailsMock, getLeadByIdMock, getCaseByIdMock,
    updateLeadStageMock, recomputeCaseStatusMock, getCampaignForCaseMock, sendViaMailboxMock, scheduleFirstFollowupMock,
    enqueueCrmSyncMock, logEventSafeMock, getSequenceByLeadIdMock, advanceSequenceMock, stopSequenceMock,
    publishDelayMock,
  ]) {
    m.mockReset()
  }
  getLeadByIdMock.mockResolvedValue({ id: 'lead1', status: 'active', email: 'jane@acme.com' })
  getCaseByIdMock.mockResolvedValue({ id: 'case1', status: 'contacted' })
  getCampaignForCaseMock.mockResolvedValue({ status: 'active', mailbox_ids: ['m1'] })
  claimWaitingOutboundEmailMock.mockResolvedValue(waitingEmail({ status: 'queued' }))
  sendViaMailboxMock.mockResolvedValue({ mailboxId: 'm1', providerMessageId: 'pm1', threadId: 'thr1' })
  hasInboundReplyMock.mockResolvedValue(false)
  recomputeCaseStatusMock.mockResolvedValue({ status: 'contacted', didChange: true })
})

describe('sweepFailedFirstTouch — first touch', () => {
  it('should resend a stranded lead on an already-contacted case without re-flipping status', async () => {
    listWaitingOutboundEmailsMock.mockResolvedValue([waitingEmail()])
    recomputeCaseStatusMock.mockResolvedValue({ status: 'contacted', didChange: false })

    const results = await sweepFailedFirstTouch(SUPABASE, 50)

    expect(claimWaitingOutboundEmailMock).toHaveBeenCalledWith(SUPABASE, 'e1')
    expect(sendViaMailboxMock).toHaveBeenCalledWith(SUPABASE, expect.objectContaining({
      to: 'jane@acme.com', subject: 'Hi there', body: 'Body text', purpose: 'outreach',
    }))
    expect(markEmailSentMock).toHaveBeenCalledWith(SUPABASE, 'e1', {
      providerMessageId: 'pm1', threadId: 'thr1', mailboxId: 'm1',
    })
    expect(scheduleFirstFollowupMock).toHaveBeenCalledWith(SUPABASE, { clientId: 'c1', caseId: 'case1', leadId: 'lead1' })
    expect(updateLeadStageMock).toHaveBeenCalledWith(SUPABASE, 'lead1', { stage: 'contacted' })
    // Case is already 'contacted' — recompute reports no change, so no re-fired CRM sync.
    expect(enqueueCrmSyncMock).not.toHaveBeenCalled()
    expect(results).toEqual([{ emailId: 'e1', outcome: 'sent' }])
  })

  it('should advance a still-pre-contact case to contacted and fire the CRM sync on send', async () => {
    listWaitingOutboundEmailsMock.mockResolvedValue([waitingEmail()])
    getCaseByIdMock.mockResolvedValue({ id: 'case1', status: 'waiting' })
    recomputeCaseStatusMock.mockResolvedValue({ status: 'contacted', didChange: true })

    await sweepFailedFirstTouch(SUPABASE, 50)

    expect(updateLeadStageMock).toHaveBeenCalledWith(SUPABASE, 'lead1', { stage: 'contacted' })
    expect(recomputeCaseStatusMock).toHaveBeenCalledWith(SUPABASE, 'case1')
    expect(enqueueCrmSyncMock).toHaveBeenCalledWith('case1', 'contacted')
  })

  it('should mark the email waiting again (not failed) and report rate_limited, without touching lead/case bookkeeping, on a cap/gate failure', async () => {
    listWaitingOutboundEmailsMock.mockResolvedValue([waitingEmail()])
    sendViaMailboxMock.mockRejectedValue(new AppError('RATE_LIMITED', 'All mailboxes at daily cap', {}))

    const results = await sweepFailedFirstTouch(SUPABASE, 50)

    expect(markEmailWaitingMock).toHaveBeenCalledWith(SUPABASE, 'e1')
    expect(markEmailFailedMock).not.toHaveBeenCalled()
    expect(updateLeadStageMock).not.toHaveBeenCalled()
    expect(recomputeCaseStatusMock).not.toHaveBeenCalled()
    expect(results).toEqual([{ emailId: 'e1', outcome: 'rate_limited' }])
  })

  it('should mark the email failed, log, and continue the batch on a genuine (non-RATE_LIMITED) send error', async () => {
    listWaitingOutboundEmailsMock.mockResolvedValue([
      waitingEmail({ id: 'e1', lead_id: 'lead1' }),
      waitingEmail({ id: 'e2', lead_id: 'lead2' }),
    ])
    getLeadByIdMock.mockImplementation((_s: unknown, leadId: string) =>
      Promise.resolve({ id: leadId, status: 'active', email: `${leadId}@acme.com` }),
    )
    claimWaitingOutboundEmailMock.mockImplementation((_s: unknown, id: string) =>
      Promise.resolve(waitingEmail({ id, lead_id: id === 'e1' ? 'lead1' : 'lead2', status: 'queued' })),
    )
    sendViaMailboxMock.mockRejectedValueOnce(new Error('smtp exploded')).mockResolvedValueOnce({
      mailboxId: 'm1', providerMessageId: 'pm2', threadId: 'thr2',
    })

    const results = await sweepFailedFirstTouch(SUPABASE, 50)

    expect(markEmailFailedMock).toHaveBeenCalledWith(SUPABASE, 'e1')
    expect(logEventSafeMock).toHaveBeenCalledWith(expect.objectContaining({
      type: 'pipeline.resend_failed.error', payload: expect.objectContaining({ emailId: 'e1' }),
    }))
    // The second email in the batch still gets processed after the first fails.
    expect(results).toEqual([
      { emailId: 'e1', outcome: 'failed' },
      { emailId: 'e2', outcome: 'sent' },
    ])
  })

  // Regression tests: a permanently-disqualified 'waiting' row used to just
  // return 'skipped' forever — re-fetched and re-skipped on every sweep tick
  // indefinitely, since nothing ever moved it out of 'waiting'. It must now
  // land on the terminal 'failed' status instead.
  it('should mark a malformed row failed instead of leaving it waiting forever', async () => {
    listWaitingOutboundEmailsMock.mockResolvedValue([waitingEmail({ lead_id: null })])

    const results = await sweepFailedFirstTouch(SUPABASE, 50)

    expect(markEmailFailedMock).toHaveBeenCalledWith(SUPABASE, 'e1')
    expect(getLeadByIdMock).not.toHaveBeenCalled()
    expect(claimWaitingOutboundEmailMock).not.toHaveBeenCalled()
    expect(results).toEqual([{ emailId: 'e1', outcome: 'skipped' }])
  })

  it('should skip without sending, and mark it failed, when the lead is no longer active', async () => {
    listWaitingOutboundEmailsMock.mockResolvedValue([waitingEmail()])
    getLeadByIdMock.mockResolvedValue({ id: 'lead1', status: 'stopped', email: 'jane@acme.com' })

    const results = await sweepFailedFirstTouch(SUPABASE, 50)

    expect(claimWaitingOutboundEmailMock).not.toHaveBeenCalled()
    expect(sendViaMailboxMock).not.toHaveBeenCalled()
    expect(markEmailFailedMock).toHaveBeenCalledWith(SUPABASE, 'e1')
    expect(results).toEqual([{ emailId: 'e1', outcome: 'skipped' }])
  })

  it('should skip without sending, and mark it failed, when the lead has no email address', async () => {
    listWaitingOutboundEmailsMock.mockResolvedValue([waitingEmail()])
    getLeadByIdMock.mockResolvedValue({ id: 'lead1', status: 'active', email: null })

    const results = await sweepFailedFirstTouch(SUPABASE, 50)

    expect(sendViaMailboxMock).not.toHaveBeenCalled()
    expect(markEmailFailedMock).toHaveBeenCalledWith(SUPABASE, 'e1')
    expect(results).toEqual([{ emailId: 'e1', outcome: 'skipped' }])
  })

  it.each(['won', 'lost', 'dead'] as const)('should skip a case that is already closed out (%s), and mark it failed', async (status) => {
    listWaitingOutboundEmailsMock.mockResolvedValue([waitingEmail()])
    getCaseByIdMock.mockResolvedValue({ id: 'case1', status })

    const results = await sweepFailedFirstTouch(SUPABASE, 50)

    expect(claimWaitingOutboundEmailMock).not.toHaveBeenCalled()
    expect(markEmailFailedMock).toHaveBeenCalledWith(SUPABASE, 'e1')
    expect(results).toEqual([{ emailId: 'e1', outcome: 'skipped' }])
  })

  it('should skip and mark it failed when the case no longer exists', async () => {
    listWaitingOutboundEmailsMock.mockResolvedValue([waitingEmail()])
    getCaseByIdMock.mockResolvedValue(null)

    const results = await sweepFailedFirstTouch(SUPABASE, 50)

    expect(markEmailFailedMock).toHaveBeenCalledWith(SUPABASE, 'e1')
    expect(results).toEqual([{ emailId: 'e1', outcome: 'skipped' }])
  })

  it('should skip and mark it failed when the campaign no longer exists', async () => {
    listWaitingOutboundEmailsMock.mockResolvedValue([waitingEmail()])
    getCampaignForCaseMock.mockResolvedValue(null)

    const results = await sweepFailedFirstTouch(SUPABASE, 50)

    expect(claimWaitingOutboundEmailMock).not.toHaveBeenCalled()
    expect(markEmailFailedMock).toHaveBeenCalledWith(SUPABASE, 'e1')
    expect(results).toEqual([{ emailId: 'e1', outcome: 'skipped' }])
  })

  it('should skip and mark it failed when the campaign is archived', async () => {
    listWaitingOutboundEmailsMock.mockResolvedValue([waitingEmail()])
    getCampaignForCaseMock.mockResolvedValue({ status: 'archived', mailbox_ids: ['m1'] })

    const results = await sweepFailedFirstTouch(SUPABASE, 50)

    expect(claimWaitingOutboundEmailMock).not.toHaveBeenCalled()
    expect(markEmailFailedMock).toHaveBeenCalledWith(SUPABASE, 'e1')
    expect(results).toEqual([{ emailId: 'e1', outcome: 'skipped' }])
  })

  // A pause is expected to resume — unlike the permanent conditions above,
  // this must stay 'waiting' (no markEmailFailed) so the row auto-resumes
  // once the operator unpauses the campaign.
  it('should skip without marking it failed when the campaign is merely paused', async () => {
    listWaitingOutboundEmailsMock.mockResolvedValue([waitingEmail()])
    getCampaignForCaseMock.mockResolvedValue({ status: 'paused', mailbox_ids: ['m1'] })

    const results = await sweepFailedFirstTouch(SUPABASE, 50)

    expect(claimWaitingOutboundEmailMock).not.toHaveBeenCalled()
    expect(markEmailFailedMock).not.toHaveBeenCalled()
    expect(results).toEqual([{ emailId: 'e1', outcome: 'skipped' }])
  })

  it('should skip without sending when the reclaim loses the race (already handled concurrently)', async () => {
    listWaitingOutboundEmailsMock.mockResolvedValue([waitingEmail()])
    claimWaitingOutboundEmailMock.mockResolvedValue(null)

    const results = await sweepFailedFirstTouch(SUPABASE, 50)

    expect(sendViaMailboxMock).not.toHaveBeenCalled()
    expect(results).toEqual([{ emailId: 'e1', outcome: 'skipped' }])
  })

  it('should pass the limit through to the list query and return an empty array when nothing is waiting', async () => {
    listWaitingOutboundEmailsMock.mockResolvedValue([])

    const results = await sweepFailedFirstTouch(SUPABASE, 25)

    expect(listWaitingOutboundEmailsMock).toHaveBeenCalledWith(SUPABASE, 25)
    expect(results).toEqual([])
  })
})

describe('sweepFailedFirstTouch — follow-up steps', () => {
  it('should resend a follow-up step as-is, thread it onto the prior message, and advance the sequence', async () => {
    listWaitingOutboundEmailsMock.mockResolvedValue([
      waitingEmail({ id: 'e2', sequence_step: 1, subject: 'Re: Hi there', thread_id: 'thr1' }),
    ])
    claimWaitingOutboundEmailMock.mockResolvedValue({
      id: 'e2', subject: 'Re: Hi there', body: 'Body text', thread_id: 'thr1',
    })
    getSequenceByLeadIdMock.mockResolvedValue({
      id: 'seq1', lead_id: 'lead1', followup_delays_days: [3, 7, 14],
    })
    listThreadEmailsMock.mockResolvedValue([
      { id: 'e1', direction: 'outbound', provider_message_id: 'pm-orig', thread_id: 'thr1' },
    ])
    publishDelayMock.mockResolvedValue('qmsg-next')

    const results = await sweepFailedFirstTouch(SUPABASE, 50)

    expect(results).toEqual([{ emailId: 'e2', outcome: 'sent' }])
    expect(sendViaMailboxMock).toHaveBeenCalledWith(SUPABASE, expect.objectContaining({
      threadId: 'thr1', inReplyToMessageId: 'pm-orig', references: 'pm-orig',
    }))
    expect(advanceSequenceMock).toHaveBeenCalledWith(SUPABASE, 'seq1', expect.objectContaining({ currentStep: 1 }))
    expect(publishDelayMock).toHaveBeenCalledWith('/api/pipeline/followup', { sequenceId: 'seq1', step: 2 }, 7 * 86_400)
    expect(scheduleFirstFollowupMock).not.toHaveBeenCalled()
  })

  it('should stop the sequence and mark the case dead on the final follow-up step', async () => {
    listWaitingOutboundEmailsMock.mockResolvedValue([
      waitingEmail({ id: 'e3', sequence_step: 3, thread_id: 'thr1' }),
    ])
    claimWaitingOutboundEmailMock.mockResolvedValue({ id: 'e3', subject: 'Re: Hi there', body: 'Body text', thread_id: 'thr1' })
    getSequenceByLeadIdMock.mockResolvedValue({ id: 'seq1', lead_id: 'lead1', followup_delays_days: [3, 7, 14] })
    listThreadEmailsMock.mockResolvedValue([{ id: 'e1', direction: 'outbound', provider_message_id: 'pm-orig', thread_id: 'thr1' }])
    recomputeCaseStatusMock.mockResolvedValue({ status: 'dead', didChange: true })

    const results = await sweepFailedFirstTouch(SUPABASE, 50)

    expect(results).toEqual([{ emailId: 'e3', outcome: 'sent' }])
    expect(stopSequenceMock).toHaveBeenCalledWith(SUPABASE, 'seq1', 'stopped')
    expect(updateLeadStageMock).toHaveBeenCalledWith(SUPABASE, 'lead1', { stage: 'dead' })
    expect(recomputeCaseStatusMock).toHaveBeenCalledWith(SUPABASE, 'case1')
    expect(enqueueCrmSyncMock).toHaveBeenCalledWith('case1', 'dead')
    expect(advanceSequenceMock).not.toHaveBeenCalled()
  })

  it('should not enqueue a CRM sync when recompute reports the case was already contacted', async () => {
    listWaitingOutboundEmailsMock.mockResolvedValue([waitingEmail()])
    recomputeCaseStatusMock.mockResolvedValue({ status: 'contacted', didChange: false })

    await sweepFailedFirstTouch(SUPABASE, 50)

    expect(enqueueCrmSyncMock).not.toHaveBeenCalled()
  })

  it('should skip, stop the sequence, and mark the email failed when a reply arrived while the step sat waiting', async () => {
    listWaitingOutboundEmailsMock.mockResolvedValue([waitingEmail({ id: 'e4', sequence_step: 1 })])
    hasInboundReplyMock.mockResolvedValue(true)
    getSequenceByLeadIdMock.mockResolvedValue({ id: 'seq1', lead_id: 'lead1', followup_delays_days: [3, 7, 14] })

    const results = await sweepFailedFirstTouch(SUPABASE, 50)

    expect(results).toEqual([{ emailId: 'e4', outcome: 'skipped' }])
    expect(stopSequenceMock).toHaveBeenCalledWith(SUPABASE, 'seq1', 'completed')
    expect(claimWaitingOutboundEmailMock).not.toHaveBeenCalled()
    expect(sendViaMailboxMock).not.toHaveBeenCalled()
    expect(markEmailFailedMock).toHaveBeenCalledWith(SUPABASE, 'e4')
  })

  it('should skip and mark the email failed for a follow-up step whose sequence was already stopped', async () => {
    listWaitingOutboundEmailsMock.mockResolvedValue([waitingEmail({ id: 'e5', sequence_step: 1 })])
    getSequenceByLeadIdMock.mockResolvedValue(null)

    const results = await sweepFailedFirstTouch(SUPABASE, 50)

    expect(results).toEqual([{ emailId: 'e5', outcome: 'skipped' }])
    expect(claimWaitingOutboundEmailMock).not.toHaveBeenCalled()
    expect(markEmailFailedMock).toHaveBeenCalledWith(SUPABASE, 'e5')
  })

  // Regression test: the thread filter used to only exclude this row itself,
  // so a same-lead row that was never actually delivered (no
  // provider_message_id — e.g. a manual send still mid-flight) but happened
  // to be the newest by created_at would be picked as the In-Reply-To
  // target, producing a broken thread reference.
  it('should skip an undelivered thread row and reference the last actually-sent message instead', async () => {
    listWaitingOutboundEmailsMock.mockResolvedValue([
      waitingEmail({ id: 'e2', sequence_step: 1, thread_id: 'thr1' }),
    ])
    claimWaitingOutboundEmailMock.mockResolvedValue({
      id: 'e2', subject: 'Re: Hi there', body: 'Body text', thread_id: 'thr1',
    })
    getSequenceByLeadIdMock.mockResolvedValue({ id: 'seq1', lead_id: 'lead1', followup_delays_days: [3, 7, 14] })
    listThreadEmailsMock.mockResolvedValue([
      { id: 'e1', direction: 'outbound', provider_message_id: 'pm-orig', thread_id: 'thr1' },
      // Newer by position (ascending order), but never delivered — must be
      // skipped in favor of e1's real provider_message_id.
      { id: 'e-manual', direction: 'outbound', provider_message_id: null, thread_id: 'thr1' },
    ])
    publishDelayMock.mockResolvedValue('qmsg-next')

    await sweepFailedFirstTouch(SUPABASE, 50)

    expect(sendViaMailboxMock).toHaveBeenCalledWith(SUPABASE, expect.objectContaining({
      inReplyToMessageId: 'pm-orig', references: 'pm-orig',
    }))
  })

  // Regression test: the whole post-send block (markEmailSent, follow-up
  // scheduling, case/sequence bookkeeping) used to share the same try/catch
  // as sendViaMailbox itself, so a bookkeeping failure after a real,
  // successful send was indistinguishable from a delivery failure — the
  // already-sent email got its status corrupted to 'failed' in the DB.
  it('should not mark the email failed in the DB when post-send bookkeeping throws after a real send', async () => {
    listWaitingOutboundEmailsMock.mockResolvedValue([waitingEmail()])
    scheduleFirstFollowupMock.mockRejectedValue(new Error('qstash down'))

    const results = await sweepFailedFirstTouch(SUPABASE, 50)

    expect(markEmailSentMock).toHaveBeenCalled()
    expect(markEmailFailedMock).not.toHaveBeenCalled()
    expect(results).toEqual([{ emailId: 'e1', outcome: 'failed' }])
    expect(logEventSafeMock).toHaveBeenCalledWith(expect.objectContaining({
      type: 'pipeline.resend_failed.error', payload: expect.objectContaining({ emailId: 'e1' }),
    }))
  })

  // Regression: a scheduleFirstFollowup failure used to short-circuit
  // updateLeadStage/recomputeCaseStatus entirely — this row will never be
  // 'waiting' again (it's now 'sent'), so those writes must land before
  // scheduling is even attempted, not depend on it succeeding.
  it('should still advance the lead/case even when follow-up scheduling throws after a real send', async () => {
    listWaitingOutboundEmailsMock.mockResolvedValue([waitingEmail()])
    getCaseByIdMock.mockResolvedValue({ id: 'case1', status: 'waiting' })
    recomputeCaseStatusMock.mockResolvedValue({ status: 'contacted', didChange: true })
    scheduleFirstFollowupMock.mockRejectedValue(new Error('qstash down'))

    await sweepFailedFirstTouch(SUPABASE, 50)

    expect(updateLeadStageMock).toHaveBeenCalledWith(SUPABASE, 'lead1', { stage: 'contacted' })
    expect(recomputeCaseStatusMock).toHaveBeenCalledWith(SUPABASE, 'case1')
    expect(enqueueCrmSyncMock).toHaveBeenCalledWith('case1', 'contacted')
  })
})
