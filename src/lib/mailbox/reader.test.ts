import { describe, it, expect, vi, beforeEach } from 'vitest'

const getMailboxProviderMock = vi.fn()
const updateMailboxOauthMock = vi.fn()
const logEventMock = vi.fn()

vi.mock('@/lib/mailbox/registry', () => ({ getMailboxProvider: (...a: unknown[]) => getMailboxProviderMock(...a) }))
vi.mock('@/lib/db/mailboxes', () => ({ updateMailboxOauth: (...a: unknown[]) => updateMailboxOauthMock(...a) }))
vi.mock('@/lib/events/log-event', () => ({ logEventSafe: (...a: unknown[]) => logEventMock(...a) }))

import { readInboundForMailbox } from './reader'

const mailboxOauth = { accessToken: 'at', refreshToken: 'rt', expiresAt: new Date(Date.now() + 60_000).toISOString() }
const mailbox = {
  id: 'm1', client_id: 'c1', provider: 'gmail',
  oauth: mailboxOauth,
  inbound_cursor: '1000',
} as never

beforeEach(() => {
  getMailboxProviderMock.mockReset(); updateMailboxOauthMock.mockReset(); logEventMock.mockReset()
})

describe('readInboundForMailbox', () => {
  it('should fetch inbound, persist refreshed tokens against the original snapshot, and return the result', async () => {
    const fetchInbound = vi.fn().mockResolvedValue({
      result: { messages: [{ providerMessageId: 'm1' }], cursor: '1050' },
      tokens: { accessToken: 'at2', refreshToken: 'rt', expiresAt: 'later' },
    })
    getMailboxProviderMock.mockReturnValue({ fetchInbound })
    const result = await readInboundForMailbox({} as never, mailbox)
    expect(fetchInbound).toHaveBeenCalledWith(expect.objectContaining({ accessToken: 'at' }), '1000')
    // Persisted tokens are encrypted at rest (see tokens.test.ts for the
    // encrypt/decrypt round-trip) — assert the ciphertext envelope shape here,
    // not the plaintext accessToken.
    expect(updateMailboxOauthMock).toHaveBeenCalledWith(
      {},
      'm1',
      expect.objectContaining({ v: 1, iv: expect.any(String), tag: expect.any(String), data: expect.any(String) }),
      mailboxOauth,
    )
    expect(result.cursor).toBe('1050')
  })

  it('should not fail the read when persisting refreshed tokens fails', async () => {
    getMailboxProviderMock.mockReturnValue({
      fetchInbound: vi.fn().mockResolvedValue({ result: { messages: [], cursor: '1050' }, tokens: { accessToken: 'at2' } }),
    })
    updateMailboxOauthMock.mockRejectedValue(new Error('db down'))
    const result = await readInboundForMailbox({} as never, mailbox)
    expect(result.cursor).toBe('1050')
    expect(logEventMock).toHaveBeenCalled()
  })

  it('should skip persisting when the provider did not refresh the tokens', async () => {
    getMailboxProviderMock.mockReturnValue({
      // Mirrors ensureFresh: returns the exact tokens object it received when unexpired.
      fetchInbound: vi.fn().mockImplementation((tokens) =>
        Promise.resolve({ result: { messages: [], cursor: '1050' }, tokens }),
      ),
    })
    const result = await readInboundForMailbox({} as never, mailbox)
    expect(result.cursor).toBe('1050')
    expect(updateMailboxOauthMock).not.toHaveBeenCalled()
  })
})
