import { describe, it, expect, vi, beforeEach } from 'vitest'

const readInboundMock = vi.fn()
const findLeadMock = vi.fn()
const insertInboundMock = vi.fn()
const getEmailByProviderMessageIdMock = vi.fn()
const pauseSequenceMock = vi.fn()
const updateCursorMock = vi.fn()
const publishJsonMock = vi.fn()
const logEventMock = vi.fn()
const handleBounce = vi.fn()

vi.mock('@/lib/mailbox/reader', () => ({ readInboundForMailbox: (...a: unknown[]) => readInboundMock(...a) }))
vi.mock('@/lib/db/leads', () => ({ findContactedLeadByEmail: (...a: unknown[]) => findLeadMock(...a) }))
vi.mock('@/lib/db/emails', () => ({
  insertInboundEmail: (...a: unknown[]) => insertInboundMock(...a),
  getEmailByProviderMessageId: (...a: unknown[]) => getEmailByProviderMessageIdMock(...a),
}))
vi.mock('@/lib/db/sequences', () => ({ pauseActiveSequenceForLead: (...a: unknown[]) => pauseSequenceMock(...a) }))
vi.mock('@/lib/db/mailboxes', () => ({ updateInboundCursor: (...a: unknown[]) => updateCursorMock(...a) }))
vi.mock('@/lib/qstash/client', () => ({ publishJson: (...a: unknown[]) => publishJsonMock(...a) }))
vi.mock('@/lib/events/log-event', () => ({ logEventSafe: (...a: unknown[]) => logEventMock(...a) }))
vi.mock('@/lib/pipeline/bounce', () => ({ handleBounce: (...a: unknown[]) => handleBounce(...a) }))

import { ingestInboundForMailbox } from './inbound'

const mailbox = { id: 'm1', client_id: 'c1', email_address: 'ops@acmerobotics.com' } as never
const message = {
  providerMessageId: 'g1', threadId: 't1', fromEmail: 'jane@acme.com',
  subject: 'Re: idea', body: 'Interested', receivedAt: '2026-07-19T10:00:00Z', headers: {},
}

beforeEach(() => {
  for (const m of [readInboundMock, findLeadMock, insertInboundMock, getEmailByProviderMessageIdMock,
    pauseSequenceMock, updateCursorMock, publishJsonMock, logEventMock, handleBounce]) m.mockReset()
  readInboundMock.mockResolvedValue({ messages: [message], cursor: '1050' })
  findLeadMock.mockResolvedValue({ id: 'lead1', case_id: 'case1' })
  insertInboundMock.mockResolvedValue({ id: 'in1' })
})

describe('ingestInboundForMailbox', () => {
  it('should ingest a matched reply, pause the sequence, enqueue reply, and advance the cursor', async () => {
    const summary = await ingestInboundForMailbox({} as never, mailbox)
    expect(findLeadMock).toHaveBeenCalledWith({}, 'c1', 'jane@acme.com', 'm1')
    expect(insertInboundMock).toHaveBeenCalledWith({}, expect.objectContaining({ direction: 'inbound', lead_id: 'lead1', case_id: 'case1' }))
    expect(pauseSequenceMock).toHaveBeenCalledWith({}, 'lead1')
    expect(publishJsonMock).toHaveBeenCalledWith('/api/inbound/reply', { emailId: 'in1' })
    expect(updateCursorMock).toHaveBeenCalledWith({}, 'm1', '1050')
    expect(summary).toEqual({ mailboxId: 'm1', ingested: 1, enqueued: 1, bounces: 0, autoReplies: 0 })
  })

  it('should skip a message with no matching contacted lead', async () => {
    findLeadMock.mockResolvedValue(null)
    const summary = await ingestInboundForMailbox({} as never, mailbox)
    expect(insertInboundMock).not.toHaveBeenCalled()
    expect(summary).toEqual({ mailboxId: 'm1', ingested: 0, enqueued: 0, bounces: 0, autoReplies: 0 })
    expect(updateCursorMock).toHaveBeenCalledWith({}, 'm1', '1050')
  })

  it('should retry pause and publish for an already-ingested message left with incomplete downstream work', async () => {
    insertInboundMock.mockResolvedValue(null) // dedup: row already exists (e.g. a prior crashed run)
    getEmailByProviderMessageIdMock.mockResolvedValue({ id: 'in1' })
    const summary = await ingestInboundForMailbox({} as never, mailbox)
    expect(getEmailByProviderMessageIdMock).toHaveBeenCalledWith({}, 'g1')
    expect(pauseSequenceMock).toHaveBeenCalledWith({}, 'lead1')
    expect(publishJsonMock).toHaveBeenCalledWith('/api/inbound/reply', { emailId: 'in1' })
    expect(logEventMock).not.toHaveBeenCalled() // not counted as newly ingested
    expect(summary).toEqual({ mailboxId: 'm1', ingested: 0, enqueued: 1, bounces: 0, autoReplies: 0 })
  })

  it('should skip pause/publish when the dedup lookup finds no existing row', async () => {
    insertInboundMock.mockResolvedValue(null)
    getEmailByProviderMessageIdMock.mockResolvedValue(null)
    const summary = await ingestInboundForMailbox({} as never, mailbox)
    expect(pauseSequenceMock).not.toHaveBeenCalled()
    expect(publishJsonMock).not.toHaveBeenCalled()
    expect(summary).toEqual({ mailboxId: 'm1', ingested: 0, enqueued: 0, bounces: 0, autoReplies: 0 })
  })
})

describe('bounce and auto-reply routing', () => {
  it('should route a DSN to the bounce handler and never store it as a reply', async () => {
    readInboundMock.mockResolvedValue({
      cursor: 'next',
      messages: [
        {
          providerMessageId: 'pm-dsn', threadId: 't', fromEmail: 'mailer-daemon@googlemail.com',
          subject: 'Delivery Status Notification (Failure)',
          body: 'Final-Recipient: rfc822; vp@target.com\nStatus: 5.1.1',
          receivedAt: '2026-07-22T10:00:00.000Z', headers: {},
        },
      ],
    })
    handleBounce.mockResolvedValue('suppressed')

    const summary = await ingestInboundForMailbox({} as never, mailbox)

    expect(handleBounce).toHaveBeenCalledOnce()
    expect(insertInboundMock).not.toHaveBeenCalled()
    expect(publishJsonMock).not.toHaveBeenCalled()
    expect(summary.bounces).toBe(1)
  })

  it('should ignore an out-of-office without pausing the sequence', async () => {
    readInboundMock.mockResolvedValue({
      cursor: 'next',
      messages: [
        {
          providerMessageId: 'pm-ooo', threadId: 't', fromEmail: 'vp@target.com',
          subject: 'Automatic reply: Quick question', body: 'I am away until Monday.',
          receivedAt: '2026-07-22T10:00:00.000Z', headers: { 'auto-submitted': 'auto-replied' },
        },
      ],
    })

    const summary = await ingestInboundForMailbox({} as never, mailbox)

    expect(insertInboundMock).not.toHaveBeenCalled()
    expect(pauseSequenceMock).not.toHaveBeenCalled()
    expect(publishJsonMock).not.toHaveBeenCalled()
    expect(summary.autoReplies).toBe(1)
  })

  it('should still advance the cursor when every message was a bounce', async () => {
    readInboundMock.mockResolvedValue({
      cursor: 'next',
      messages: [
        {
          providerMessageId: 'pm-dsn', threadId: 't', fromEmail: 'mailer-daemon@googlemail.com',
          subject: 'Failure notice', body: 'Status: 5.1.1\nFinal-Recipient: rfc822; vp@target.com',
          receivedAt: '2026-07-22T10:00:00.000Z', headers: {},
        },
      ],
    })
    handleBounce.mockResolvedValue('suppressed')

    await ingestInboundForMailbox({} as never, mailbox)

    expect(updateCursorMock).toHaveBeenCalledWith({}, 'm1', 'next')
  })
})
