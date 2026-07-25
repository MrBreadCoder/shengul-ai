import { describe, it, expect, vi, beforeEach } from 'vitest'

const claimCollisionNoticeMock = vi.fn()
const listOtherActiveLeadsMock = vi.fn()
const publishJsonMock = vi.fn()
const isSequenceActiveForLeadMock = vi.fn()
const getLeadByIdMock = vi.fn()
const getCampaignForCaseMock = vi.fn()
const listThreadEmailsMock = vi.fn()
const claimOutboundEmailMock = vi.fn()
const markEmailSentMock = vi.fn()
const markEmailFailedMock = vi.fn()
const stopSequenceForLeadMock = vi.fn()
const sendViaMailboxMock = vi.fn()
const logEventMock = vi.fn()

vi.mock('@/lib/db/cases', () => ({ claimCollisionNotice: (...a: unknown[]) => claimCollisionNoticeMock(...a) }))
vi.mock('@/lib/db/leads', () => ({
  listOtherActiveLeadsForCollisionNotice: (...a: unknown[]) => listOtherActiveLeadsMock(...a),
  getLeadById: (...a: unknown[]) => getLeadByIdMock(...a),
}))
vi.mock('@/lib/db/campaigns', () => ({ getCampaignForCase: (...a: unknown[]) => getCampaignForCaseMock(...a) }))
vi.mock('@/lib/db/emails', () => ({
  listThreadEmails: (...a: unknown[]) => listThreadEmailsMock(...a),
  claimOutboundEmail: (...a: unknown[]) => claimOutboundEmailMock(...a),
  markEmailSent: (...a: unknown[]) => markEmailSentMock(...a),
  markEmailFailed: (...a: unknown[]) => markEmailFailedMock(...a),
}))
vi.mock('@/lib/db/sequences', () => ({
  isSequenceActiveForLead: (...a: unknown[]) => isSequenceActiveForLeadMock(...a),
  stopSequenceForLead: (...a: unknown[]) => stopSequenceForLeadMock(...a),
}))
vi.mock('@/lib/mailbox/sender', () => ({ sendViaMailbox: (...a: unknown[]) => sendViaMailboxMock(...a) }))
vi.mock('@/lib/qstash/client', () => ({ publishJson: (...a: unknown[]) => publishJsonMock(...a) }))
vi.mock('@/lib/events/log-event', () => ({ logEventSafe: (...a: unknown[]) => logEventMock(...a) }))

import { triggerCollisionNotice, runCollisionNotice } from './collision-notify'
import { AppError } from '@/lib/errors/app-error'

beforeEach(() => {
  for (const m of [
    claimCollisionNoticeMock, listOtherActiveLeadsMock, publishJsonMock, isSequenceActiveForLeadMock,
    getLeadByIdMock, getCampaignForCaseMock, listThreadEmailsMock, claimOutboundEmailMock,
    markEmailSentMock, markEmailFailedMock, stopSequenceForLeadMock, sendViaMailboxMock, logEventMock,
  ]) m.mockReset()
})

describe('triggerCollisionNotice', () => {
  it('should no-op without querying leads when the case claim is already taken', async () => {
    claimCollisionNoticeMock.mockResolvedValue(false)
    await triggerCollisionNotice({} as never, 'case1', 'leadTrigger')
    expect(listOtherActiveLeadsMock).not.toHaveBeenCalled()
    expect(publishJsonMock).not.toHaveBeenCalled()
  })

  it('should publish one QStash message per other active lead when it wins the claim', async () => {
    claimCollisionNoticeMock.mockResolvedValue(true)
    listOtherActiveLeadsMock.mockResolvedValue([{ id: 'leadA' }, { id: 'leadB' }])
    await triggerCollisionNotice({} as never, 'case1', 'leadTrigger')
    expect(publishJsonMock).toHaveBeenCalledTimes(2)
    expect(publishJsonMock).toHaveBeenCalledWith('/api/pipeline/collision-notify', {
      caseId: 'case1', leadId: 'leadA', triggeringLeadId: 'leadTrigger',
    })
    expect(publishJsonMock).toHaveBeenCalledWith('/api/pipeline/collision-notify', {
      caseId: 'case1', leadId: 'leadB', triggeringLeadId: 'leadTrigger',
    })
  })

  it('should not publish anything when there are no other active leads', async () => {
    claimCollisionNoticeMock.mockResolvedValue(true)
    listOtherActiveLeadsMock.mockResolvedValue([])
    await triggerCollisionNotice({} as never, 'case1', 'leadTrigger')
    expect(publishJsonMock).not.toHaveBeenCalled()
  })
})

const target = { id: 'leadTarget', client_id: 'c1', full_name: 'Jane Doe', email: 'jane@acme.com' }
const triggering = { id: 'leadTrigger', client_id: 'c1', full_name: 'Bob Smith', email: 'bob@acme.com' }
const campaign = { mailbox_ids: ['m1'], reply_mode: 'auto_send' }

describe('runCollisionNotice', () => {
  const input = { caseId: 'case1', leadId: 'leadTarget', triggeringLeadId: 'leadTrigger' }

  beforeEach(() => {
    isSequenceActiveForLeadMock.mockResolvedValue(true)
    getLeadByIdMock.mockImplementation((_s: unknown, id: string) => Promise.resolve(id === 'leadTarget' ? target : triggering))
    getCampaignForCaseMock.mockResolvedValue(campaign)
    listThreadEmailsMock.mockResolvedValue([{ direction: 'outbound', subject: 'Quick idea' }])
    claimOutboundEmailMock.mockResolvedValue({ id: 'email1' })
    sendViaMailboxMock.mockResolvedValue({ mailboxId: 'm1', providerMessageId: 'p1', threadId: 't1' })
  })

  it('should skip when the target lead already replied for real (sequence no longer active)', async () => {
    isSequenceActiveForLeadMock.mockResolvedValue(false)
    const result = await runCollisionNotice({} as never, input)
    expect(result).toEqual({ leadId: 'leadTarget', action: 'skipped' })
    expect(claimOutboundEmailMock).not.toHaveBeenCalled()
  })

  it('should skip without sending when the email slot is already claimed (duplicate QStash delivery)', async () => {
    claimOutboundEmailMock.mockResolvedValue(null)
    const result = await runCollisionNotice({} as never, input)
    expect(result).toEqual({ leadId: 'leadTarget', action: 'skipped' })
    expect(sendViaMailboxMock).not.toHaveBeenCalled()
  })

  it('should send the notice, mark it sent, and stop the sequence on auto_send', async () => {
    const result = await runCollisionNotice({} as never, input)
    expect(sendViaMailboxMock).toHaveBeenCalledWith({}, expect.objectContaining({
      to: 'jane@acme.com', purpose: 'reply',
    }))
    expect(markEmailSentMock).toHaveBeenCalledWith({}, 'email1', {
      providerMessageId: 'p1', threadId: 't1', mailboxId: 'm1',
    })
    expect(stopSequenceForLeadMock).toHaveBeenCalledWith({}, 'leadTarget', 'stopped')
    expect(result).toEqual({ leadId: 'leadTarget', action: 'notified' })
  })

  it('should name the triggering contact in the notice body', async () => {
    await runCollisionNotice({} as never, input)
    const body = (claimOutboundEmailMock.mock.calls[0]![1] as { body: string }).body
    expect(body).toContain('Bob')
    expect(body).toContain('Jane')
  })

  it('should draft (not send) on human_approve and still stop the sequence', async () => {
    getCampaignForCaseMock.mockResolvedValue({ ...campaign, reply_mode: 'human_approve' })
    const result = await runCollisionNotice({} as never, input)
    expect(sendViaMailboxMock).not.toHaveBeenCalled()
    expect(stopSequenceForLeadMock).toHaveBeenCalledWith({}, 'leadTarget', 'stopped')
    expect(result).toEqual({ leadId: 'leadTarget', action: 'notified' })
  })

  it('should rethrow RATE_LIMITED without stopping the sequence, so QStash retries', async () => {
    sendViaMailboxMock.mockRejectedValue(new AppError('RATE_LIMITED', 'no healthy mailbox'))
    await expect(runCollisionNotice({} as never, input)).rejects.toBeInstanceOf(AppError)
    expect(stopSequenceForLeadMock).not.toHaveBeenCalled()
  })

  it('should mark the email failed and skip (no throw) on FORBIDDEN (suppressed address)', async () => {
    sendViaMailboxMock.mockRejectedValue(new AppError('FORBIDDEN', 'recipient suppressed'))
    const result = await runCollisionNotice({} as never, input)
    expect(markEmailFailedMock).toHaveBeenCalledWith({}, 'email1')
    expect(result).toEqual({ leadId: 'leadTarget', action: 'skipped' })
  })

  it('should skip when the target lead has no email', async () => {
    getLeadByIdMock.mockImplementation((_s: unknown, id: string) =>
      Promise.resolve(id === 'leadTarget' ? { ...target, email: null } : triggering))
    const result = await runCollisionNotice({} as never, input)
    expect(result).toEqual({ leadId: 'leadTarget', action: 'skipped' })
  })

  it('should skip when the campaign cannot be found', async () => {
    getCampaignForCaseMock.mockResolvedValue(null)
    const result = await runCollisionNotice({} as never, input)
    expect(result).toEqual({ leadId: 'leadTarget', action: 'skipped' })
  })
})
