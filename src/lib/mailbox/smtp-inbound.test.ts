import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SmtpCredentials } from './provider'

interface FakeFetched {
  uid: number
  flags: Set<string>
  source: Buffer
}

const connectMock = vi.hoisted(() => vi.fn())
const closeMock = vi.hoisted(() => vi.fn())
const releaseMock = vi.hoisted(() => vi.fn())
const getMailboxLockMock = vi.hoisted(() => vi.fn())
const fetchMock = vi.hoisted(() => vi.fn())
const mailboxState = vi.hoisted(() => ({ value: { uidValidity: 42n, uidNext: 101 } as unknown }))

const createImapClientMock = vi.hoisted(() =>
  vi.fn(() => ({
    connect: connectMock,
    close: closeMock,
    getMailboxLock: getMailboxLockMock,
    fetch: fetchMock,
    get mailbox() {
      return mailboxState.value
    },
  })),
)
vi.mock('./smtp-connection', () => ({ createImapClient: createImapClientMock }))

const simpleParserMock = vi.hoisted(() => vi.fn())
vi.mock('mailparser', () => ({ simpleParser: simpleParserMock }))

import { fetchSmtpInbound, MAX_MESSAGES_PER_POLL } from './smtp-inbound'

const credentials: SmtpCredentials = {
  kind: 'smtp',
  emailAddress: 'ops@client.com',
  username: 'ops@client.com',
  password: 'pw',
  smtpHost: 'smtp.client.com',
  smtpPort: 587,
  smtpSecure: false,
  imapHost: 'imap.client.com',
  imapPort: 993,
  imapSecure: true,
}

function fetched(uid: number, flags: string[] = []): FakeFetched {
  return { uid, flags: new Set(flags), source: Buffer.from(`raw-${uid}`) }
}

function feed(messages: FakeFetched[]): void {
  fetchMock.mockImplementation(async function* () {
    for (const message of messages) yield message
  })
}

// A mailparser result with only the fields the mapper reads.
function parsed(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    from: { value: [{ address: 'Lead@Target.com' }] },
    subject: 'Re: your note',
    text: 'reply body',
    date: new Date('2026-07-24T10:00:00.000Z'),
    messageId: '<reply@target.com>',
    inReplyTo: undefined,
    references: undefined,
    headerLines: [
      { key: 'from', line: 'From: Lead@Target.com' },
      { key: 'subject', line: 'Subject: Re: your note' },
    ],
    ...overrides,
  }
}

beforeEach(() => {
  connectMock.mockReset().mockResolvedValue(undefined)
  closeMock.mockReset()
  releaseMock.mockReset()
  getMailboxLockMock.mockReset().mockResolvedValue({ release: releaseMock })
  fetchMock.mockReset()
  createImapClientMock.mockClear()
  simpleParserMock.mockReset().mockResolvedValue(parsed())
  mailboxState.value = { uidValidity: 42n, uidNext: 101 }
  feed([])
})

describe('fetchSmtpInbound baselining', () => {
  it('should ingest nothing and record the current position when the cursor is null', async () => {
    const result = await fetchSmtpInbound(credentials, null)
    expect(result.messages).toEqual([])
    expect(JSON.parse(result.cursor)).toEqual({ uidValidity: '42', lastUid: 100 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('should serialize uidValidity as a string because the library returns a BigInt', async () => {
    const result = await fetchSmtpInbound(credentials, null)
    // Regression guard: JSON.stringify throws on a BigInt, which would break
    // every poll rather than only an edge case.
    expect(() => JSON.parse(result.cursor)).not.toThrow()
    expect(typeof JSON.parse(result.cursor).uidValidity).toBe('string')
  })

  it('should re-baseline and ingest nothing when uidValidity no longer matches', async () => {
    const stale = JSON.stringify({ uidValidity: '41', lastUid: 50 })
    const result = await fetchSmtpInbound(credentials, stale)
    expect(result.messages).toEqual([])
    expect(JSON.parse(result.cursor)).toEqual({ uidValidity: '42', lastUid: 100 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('should re-baseline when the stored cursor is not valid JSON', async () => {
    const result = await fetchSmtpInbound(credentials, 'not-json')
    expect(result.messages).toEqual([])
    expect(JSON.parse(result.cursor)).toEqual({ uidValidity: '42', lastUid: 100 })
  })
})

describe('fetchSmtpInbound incremental fetch', () => {
  it('should request only UIDs above the stored lastUid', async () => {
    feed([fetched(11)])
    await fetchSmtpInbound(credentials, JSON.stringify({ uidValidity: '42', lastUid: 10 }))
    expect(fetchMock).toHaveBeenCalledWith('11:*', expect.anything(), { uid: true })
  })

  it('should map a fetched message into an InboundMessage', async () => {
    feed([fetched(11)])
    const result = await fetchSmtpInbound(credentials, JSON.stringify({ uidValidity: '42', lastUid: 10 }))
    expect(result.messages).toHaveLength(1)
    expect(result.messages[0]).toMatchObject({
      providerMessageId: '<reply@target.com>',
      fromEmail: 'lead@target.com',
      subject: 'Re: your note',
      body: 'reply body',
      receivedAt: '2026-07-24T10:00:00.000Z',
    })
  })

  it('should lowercase header names into the headers record', async () => {
    feed([fetched(11)])
    const result = await fetchSmtpInbound(credentials, JSON.stringify({ uidValidity: '42', lastUid: 10 }))
    expect(result.messages[0]?.headers).toMatchObject({ subject: 'Re: your note' })
  })

  it('should ignore a message at or below lastUid, which IMAP returns for an empty range', async () => {
    // `11:*` returns the newest message even when nothing is new — a standard
    // IMAP quirk that would otherwise re-ingest it on every poll.
    feed([fetched(10)])
    const result = await fetchSmtpInbound(credentials, JSON.stringify({ uidValidity: '42', lastUid: 10 }))
    expect(result.messages).toEqual([])
    expect(JSON.parse(result.cursor).lastUid).toBe(10)
  })

  it('should skip deleted and draft messages', async () => {
    feed([fetched(11, ['\\Deleted']), fetched(12, ['\\Draft'])])
    const result = await fetchSmtpInbound(credentials, JSON.stringify({ uidValidity: '42', lastUid: 10 }))
    expect(result.messages).toEqual([])
  })

  it('should advance the cursor past skipped messages so they are not replayed forever', async () => {
    feed([fetched(11, ['\\Draft']), fetched(12, ['\\Deleted'])])
    const result = await fetchSmtpInbound(credentials, JSON.stringify({ uidValidity: '42', lastUid: 10 }))
    expect(JSON.parse(result.cursor).lastUid).toBe(12)
  })

  it('should skip a message whose sender cannot be parsed', async () => {
    simpleParserMock.mockResolvedValue(parsed({ from: undefined }))
    feed([fetched(11)])
    const result = await fetchSmtpInbound(credentials, JSON.stringify({ uidValidity: '42', lastUid: 10 }))
    expect(result.messages).toEqual([])
    expect(JSON.parse(result.cursor).lastUid).toBe(11)
  })

  it('should stop at the per-poll cap and leave the remainder for the next poll', async () => {
    feed(Array.from({ length: MAX_MESSAGES_PER_POLL + 5 }, (_unused, index) => fetched(11 + index)))
    const result = await fetchSmtpInbound(credentials, JSON.stringify({ uidValidity: '42', lastUid: 10 }))
    expect(result.messages).toHaveLength(MAX_MESSAGES_PER_POLL)
    expect(JSON.parse(result.cursor).lastUid).toBe(10 + MAX_MESSAGES_PER_POLL)
  })
})

describe('fetchSmtpInbound threading', () => {
  it('should root the thread on the first References entry when present', async () => {
    simpleParserMock.mockResolvedValue(
      parsed({ references: ['<root@target.com>', '<prev@target.com>'], inReplyTo: '<prev@target.com>' }),
    )
    feed([fetched(11)])
    const result = await fetchSmtpInbound(credentials, JSON.stringify({ uidValidity: '42', lastUid: 10 }))
    expect(result.messages[0]?.threadId).toBe('<root@target.com>')
  })

  it('should accept a single-string References value', async () => {
    simpleParserMock.mockResolvedValue(parsed({ references: '<root@target.com>' }))
    feed([fetched(11)])
    const result = await fetchSmtpInbound(credentials, JSON.stringify({ uidValidity: '42', lastUid: 10 }))
    expect(result.messages[0]?.threadId).toBe('<root@target.com>')
  })

  it('should fall back to In-Reply-To when there are no References', async () => {
    simpleParserMock.mockResolvedValue(parsed({ inReplyTo: '<prev@target.com>' }))
    feed([fetched(11)])
    const result = await fetchSmtpInbound(credentials, JSON.stringify({ uidValidity: '42', lastUid: 10 }))
    expect(result.messages[0]?.threadId).toBe('<prev@target.com>')
  })

  it('should root a new thread on its own Message-ID', async () => {
    feed([fetched(11)])
    const result = await fetchSmtpInbound(credentials, JSON.stringify({ uidValidity: '42', lastUid: 10 }))
    expect(result.messages[0]?.threadId).toBe('<reply@target.com>')
  })

  it('should synthesize a stable id when the message has no Message-ID', async () => {
    simpleParserMock.mockResolvedValue(parsed({ messageId: undefined }))
    feed([fetched(11)])
    const result = await fetchSmtpInbound(credentials, JSON.stringify({ uidValidity: '42', lastUid: 10 }))
    // Includes uidValidity because a bare UID is not stable across a reset,
    // and this value is the inbound dedup key.
    expect(result.messages[0]?.providerMessageId).toBe('smtp-uid-42-11')
  })
})

describe('fetchSmtpInbound teardown', () => {
  it('should release the mailbox lock and close the client on success', async () => {
    await fetchSmtpInbound(credentials, null)
    expect(releaseMock).toHaveBeenCalledTimes(1)
    expect(closeMock).toHaveBeenCalledTimes(1)
  })

  it('should close the client when parsing throws', async () => {
    simpleParserMock.mockRejectedValue(new Error('malformed MIME'))
    feed([fetched(11)])
    await expect(
      fetchSmtpInbound(credentials, JSON.stringify({ uidValidity: '42', lastUid: 10 })),
    ).rejects.toBeDefined()
    expect(releaseMock).toHaveBeenCalledTimes(1)
    expect(closeMock).toHaveBeenCalledTimes(1)
  })

  it('should map a connection failure through the shared error mapper', async () => {
    connectMock.mockRejectedValue(Object.assign(new Error('nope'), { authenticationFailed: true }))
    await expect(fetchSmtpInbound(credentials, null)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      context: expect.objectContaining({ stage: 'imap' }),
    })
    expect(closeMock).toHaveBeenCalledTimes(1)
  })
})
