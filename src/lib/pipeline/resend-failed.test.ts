import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AppError } from '@/lib/errors/app-error'

const listFailedFirstTouchEmailsMock = vi.fn()
const claimOutboundEmailMock = vi.fn()
const markEmailSentMock = vi.fn()
const markEmailFailedMock = vi.fn()
const getLeadByIdMock = vi.fn()
const getCaseByIdMock = vi.fn()
const updateCaseStatusMock = vi.fn()
const getCampaignForCaseMock = vi.fn()
const sendViaMailboxMock = vi.fn()
const scheduleFirstFollowupMock = vi.fn()
const enqueueCrmSyncMock = vi.fn()
const logEventSafeMock = vi.fn()

vi.mock('@/lib/db/emails', () => ({
  listFailedFirstTouchEmails: (...a: unknown[]) => listFailedFirstTouchEmailsMock(...a),
  claimOutboundEmail: (...a: unknown[]) => claimOutboundEmailMock(...a),
  markEmailSent: (...a: unknown[]) => markEmailSentMock(...a),
  markEmailFailed: (...a: unknown[]) => markEmailFailedMock(...a),
}))
vi.mock('@/lib/db/leads', () => ({ getLeadById: (...a: unknown[]) => getLeadByIdMock(...a) }))
vi.mock('@/lib/db/cases', () => ({
  getCaseById: (...a: unknown[]) => getCaseByIdMock(...a),
  updateCaseStatus: (...a: unknown[]) => updateCaseStatusMock(...a),
}))
vi.mock('@/lib/db/campaigns', () => ({ getCampaignForCase: (...a: unknown[]) => getCampaignForCaseMock(...a) }))
vi.mock('@/lib/mailbox/sender', () => ({ sendViaMailbox: (...a: unknown[]) => sendViaMailboxMock(...a) }))
vi.mock('./followup', () => ({
  FIRST_TOUCH_STEP: 0,
  scheduleFirstFollowup: (...a: unknown[]) => scheduleFirstFollowupMock(...a),
}))
vi.mock('@/lib/crm/sync', () => ({ enqueueCrmSync: (...a: unknown[]) => enqueueCrmSyncMock(...a) }))
vi.mock('@/lib/events/log-event', () => ({ logEventSafe: (...a: unknown[]) => logEventSafeMock(...a) }))

import { sweepFailedFirstTouch } from './resend-failed'

const SUPABASE = {} as never

function failedEmail(overrides: Record<string, unknown> = {}) {
  return {
    id: 'e1', client_id: 'c1', case_id: 'case1', lead_id: 'lead1',
    subject: 'Hi there', body: 'Body text', status: 'failed', direction: 'outbound', sequence_step: 0,
    ...overrides,
  }
}

beforeEach(() => {
  for (const m of [listFailedFirstTouchEmailsMock, claimOutboundEmailMock, markEmailSentMock, markEmailFailedMock,
    getLeadByIdMock, getCaseByIdMock, updateCaseStatusMock, getCampaignForCaseMock, sendViaMailboxMock,
    scheduleFirstFollowupMock, enqueueCrmSyncMock, logEventSafeMock]) m.mockReset()

  getLeadByIdMock.mockResolvedValue({ id: 'lead1', status: 'active', email: 'jane@acme.com' })
  getCaseByIdMock.mockResolvedValue({ id: 'case1', status: 'contacted' })
  getCampaignForCaseMock.mockResolvedValue({ status: 'active', mailbox_ids: ['m1'] })
  claimOutboundEmailMock.mockResolvedValue(failedEmail({ status: 'queued' }))
  sendViaMailboxMock.mockResolvedValue({ mailboxId: 'm1', providerMessageId: 'pm1', threadId: 'thr1' })
})

describe('sweepFailedFirstTouch', () => {
  it('should resend a stranded lead on an already-contacted case without re-flipping status', async () => {
    listFailedFirstTouchEmailsMock.mockResolvedValue([failedEmail()])

    const results = await sweepFailedFirstTouch(SUPABASE, 50)

    expect(claimOutboundEmailMock).toHaveBeenCalledWith(SUPABASE, {
      client_id: 'c1', case_id: 'case1', lead_id: 'lead1', direction: 'outbound',
      subject: 'Hi there', body: 'Body text', status: 'queued', sequence_step: 0,
    })
    expect(sendViaMailboxMock).toHaveBeenCalledWith(SUPABASE, expect.objectContaining({
      to: 'jane@acme.com', subject: 'Hi there', body: 'Body text', purpose: 'outreach',
    }))
    expect(markEmailSentMock).toHaveBeenCalledWith(SUPABASE, 'e1', {
      providerMessageId: 'pm1', threadId: 'thr1', mailboxId: 'm1',
    })
    expect(scheduleFirstFollowupMock).toHaveBeenCalledWith(SUPABASE, { clientId: 'c1', caseId: 'case1', leadId: 'lead1' })
    // Case is already 'contacted' — must not re-transition or re-fire CRM sync.
    expect(updateCaseStatusMock).not.toHaveBeenCalled()
    expect(enqueueCrmSyncMock).not.toHaveBeenCalled()
    expect(results).toEqual([{ emailId: 'e1', outcome: 'sent' }])
  })

  it('should advance a still-pre-contact case to contacted and fire the CRM sync on send', async () => {
    listFailedFirstTouchEmailsMock.mockResolvedValue([failedEmail()])
    getCaseByIdMock.mockResolvedValue({ id: 'case1', status: 'waiting' })

    await sweepFailedFirstTouch(SUPABASE, 50)

    expect(updateCaseStatusMock).toHaveBeenCalledWith(SUPABASE, 'case1', 'contacted')
    expect(enqueueCrmSyncMock).toHaveBeenCalledWith('case1', 'contacted')
  })

  it('should mark the email failed again and report rate_limited, without touching case status, on a cap/gate failure', async () => {
    listFailedFirstTouchEmailsMock.mockResolvedValue([failedEmail()])
    sendViaMailboxMock.mockRejectedValue(new AppError('RATE_LIMITED', 'All mailboxes at daily cap', {}))

    const results = await sweepFailedFirstTouch(SUPABASE, 50)

    expect(markEmailFailedMock).toHaveBeenCalledWith(SUPABASE, 'e1')
    expect(updateCaseStatusMock).not.toHaveBeenCalled()
    expect(results).toEqual([{ emailId: 'e1', outcome: 'rate_limited' }])
  })

  it('should mark the email failed, log, and continue the batch on a genuine (non-RATE_LIMITED) send error', async () => {
    listFailedFirstTouchEmailsMock.mockResolvedValue([failedEmail({ id: 'e1' }), failedEmail({ id: 'e2', lead_id: 'lead2' })])
    getLeadByIdMock.mockImplementation((_s: unknown, leadId: string) =>
      Promise.resolve({ id: leadId, status: 'active', email: `${leadId}@acme.com` }),
    )
    claimOutboundEmailMock.mockImplementation((_s: unknown, row: { lead_id: string }) =>
      Promise.resolve(failedEmail({ id: row.lead_id === 'lead1' ? 'e1' : 'e2', lead_id: row.lead_id, status: 'queued' })),
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

  it('should skip without sending when the lead is no longer active', async () => {
    listFailedFirstTouchEmailsMock.mockResolvedValue([failedEmail()])
    getLeadByIdMock.mockResolvedValue({ id: 'lead1', status: 'stopped', email: 'jane@acme.com' })

    const results = await sweepFailedFirstTouch(SUPABASE, 50)

    expect(claimOutboundEmailMock).not.toHaveBeenCalled()
    expect(sendViaMailboxMock).not.toHaveBeenCalled()
    expect(results).toEqual([{ emailId: 'e1', outcome: 'skipped' }])
  })

  it('should skip without sending when the lead has no email address', async () => {
    listFailedFirstTouchEmailsMock.mockResolvedValue([failedEmail()])
    getLeadByIdMock.mockResolvedValue({ id: 'lead1', status: 'active', email: null })

    const results = await sweepFailedFirstTouch(SUPABASE, 50)

    expect(sendViaMailboxMock).not.toHaveBeenCalled()
    expect(results).toEqual([{ emailId: 'e1', outcome: 'skipped' }])
  })

  it.each(['won', 'lost', 'dead'] as const)('should skip a case that is already closed out (%s)', async (status) => {
    listFailedFirstTouchEmailsMock.mockResolvedValue([failedEmail()])
    getCaseByIdMock.mockResolvedValue({ id: 'case1', status })

    const results = await sweepFailedFirstTouch(SUPABASE, 50)

    expect(claimOutboundEmailMock).not.toHaveBeenCalled()
    expect(results).toEqual([{ emailId: 'e1', outcome: 'skipped' }])
  })

  it('should skip when the case no longer exists', async () => {
    listFailedFirstTouchEmailsMock.mockResolvedValue([failedEmail()])
    getCaseByIdMock.mockResolvedValue(null)

    const results = await sweepFailedFirstTouch(SUPABASE, 50)

    expect(results).toEqual([{ emailId: 'e1', outcome: 'skipped' }])
  })

  it('should skip when the campaign is missing or not active', async () => {
    listFailedFirstTouchEmailsMock.mockResolvedValue([failedEmail()])
    getCampaignForCaseMock.mockResolvedValue({ status: 'paused', mailbox_ids: ['m1'] })

    const results = await sweepFailedFirstTouch(SUPABASE, 50)

    expect(claimOutboundEmailMock).not.toHaveBeenCalled()
    expect(results).toEqual([{ emailId: 'e1', outcome: 'skipped' }])
  })

  it('should skip without sending when the reclaim loses the race (already handled concurrently)', async () => {
    listFailedFirstTouchEmailsMock.mockResolvedValue([failedEmail()])
    claimOutboundEmailMock.mockResolvedValue(null)

    const results = await sweepFailedFirstTouch(SUPABASE, 50)

    expect(sendViaMailboxMock).not.toHaveBeenCalled()
    expect(results).toEqual([{ emailId: 'e1', outcome: 'skipped' }])
  })

  it('should pass the limit through to the list query and return an empty array when nothing is failed', async () => {
    listFailedFirstTouchEmailsMock.mockResolvedValue([])

    const results = await sweepFailedFirstTouch(SUPABASE, 25)

    expect(listFailedFirstTouchEmailsMock).toHaveBeenCalledWith(SUPABASE, 25)
    expect(results).toEqual([])
  })
})
