import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { AppError } from '@/lib/errors/app-error'

const listMailboxesByIdsMock = vi.fn()
const claimMailboxSendMock = vi.fn()
const updateMailboxOauthMock = vi.fn()
const setMailboxHealthMock = vi.fn()
const getMailboxProviderMock = vi.fn()
const getSuppressionMock = vi.fn()

vi.mock('@/lib/db/mailboxes', () => ({
  listMailboxesByIds: (...a: unknown[]) => listMailboxesByIdsMock(...a),
  claimMailboxSend: (...a: unknown[]) => claimMailboxSendMock(...a),
  updateMailboxOauth: (...a: unknown[]) => updateMailboxOauthMock(...a),
  setMailboxHealth: (...a: unknown[]) => setMailboxHealthMock(...a),
}))
vi.mock('@/lib/db/suppressions', () => ({
  getSuppression: (...a: unknown[]) => getSuppressionMock(...a),
}))
vi.mock('@/lib/mailbox/registry', () => ({
  getMailboxProvider: (...a: unknown[]) => getMailboxProviderMock(...a),
}))
const logEventSafeMock = vi.fn()
const logErrorMock = vi.fn()
const logWarnMock = vi.fn()
vi.mock('@/lib/events/log-event', () => ({
  logEventSafe: (...a: unknown[]) => logEventSafeMock(...a),
  logError: (...a: unknown[]) => logErrorMock(...a),
  logWarn: (...a: unknown[]) => logWarnMock(...a),
}))

import { sendViaMailbox } from './sender'

const tokens = { accessToken: 'a', refreshToken: 'r', expiresAt: '2099-01-01T00:00:00.000Z' }
const mailbox = {
  id: 'm1', provider: 'gmail', email_address: 'me@co.com', oauth: tokens, sent_today: 0, daily_cap: 50, health: 'ok',
  warmup_profile: 'none' as 'standard' | 'slow' | 'none', warmup_started_at: null as string | null,
}
const baseInput = { clientId: 'c1', mailboxIds: ['m1'], to: 'x@y.com', subject: 's', body: 'b', maxJitterMs: 0, purpose: 'outreach' as const }

function mailboxWith(overrides: Partial<typeof mailbox>) {
  return { ...mailbox, ...overrides }
}

function okProvider() {
  const sendEmail = vi.fn().mockResolvedValue({
    result: { providerMessageId: 'pm1', threadId: 'thr1' },
    tokens: { ...tokens, accessToken: 'a2' },
  })
  return { provider: 'gmail', sendEmail }
}

beforeEach(() => {
  listMailboxesByIdsMock.mockReset(); claimMailboxSendMock.mockReset()
  updateMailboxOauthMock.mockReset(); getMailboxProviderMock.mockReset()
  setMailboxHealthMock.mockReset()
  getSuppressionMock.mockReset()
  getSuppressionMock.mockResolvedValue(null)
  logEventSafeMock.mockReset()
  logErrorMock.mockReset(); logWarnMock.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('sendViaMailbox', () => {
  it('should claim a healthy mailbox, send, persist tokens, and return the result', async () => {
    listMailboxesByIdsMock.mockResolvedValue([mailbox])
    claimMailboxSendMock.mockResolvedValue({ ...mailbox, sent_today: 1 })
    const sendEmail = vi.fn().mockResolvedValue({
      result: { providerMessageId: 'pm1', threadId: 'thr1' },
      tokens: { ...tokens, accessToken: 'a2' },
    })
    getMailboxProviderMock.mockReturnValue({ provider: 'gmail', sendEmail })
    const result = await sendViaMailbox({} as never, baseInput)
    expect(result).toEqual({ mailboxId: 'm1', providerMessageId: 'pm1', threadId: 'thr1' })
    expect(updateMailboxOauthMock).toHaveBeenCalledTimes(1)
  })

  it('should throw RATE_LIMITED when no mailbox can be claimed', async () => {
    listMailboxesByIdsMock.mockResolvedValue([mailbox])
    claimMailboxSendMock.mockResolvedValue(null) // at cap
    getMailboxProviderMock.mockReturnValue({ provider: 'gmail', sendEmail: vi.fn() })
    await expect(sendViaMailbox({} as never, baseInput)).rejects.toMatchObject({ code: 'RATE_LIMITED' })
  })

  it('should throw VALIDATION_ERROR when no mailboxes are configured', async () => {
    await expect(sendViaMailbox({} as never, { ...baseInput, mailboxIds: [] })).rejects.toBeInstanceOf(AppError)
  })

  it('should claim the least-used mailbox first when several are healthy', async () => {
    const heavy = mailboxWith({ id: 'm-heavy', sent_today: 40 })
    const light = mailboxWith({ id: 'm-light', sent_today: 2 })
    // Returned out of order to prove sorting, not input order, decides.
    listMailboxesByIdsMock.mockResolvedValue([heavy, light])
    claimMailboxSendMock.mockResolvedValue({ ...light, sent_today: 3 })
    getMailboxProviderMock.mockReturnValue(okProvider())

    const result = await sendViaMailbox({} as never, { ...baseInput, mailboxIds: ['m-heavy', 'm-light'] })

    expect(claimMailboxSendMock).toHaveBeenCalledTimes(1)
    expect(claimMailboxSendMock).toHaveBeenCalledWith(expect.anything(), 'm-light', 50)
    expect(result.mailboxId).toBe('m-light')
  })

  it('should fall through to the next mailbox when the first is at cap', async () => {
    const first = mailboxWith({ id: 'm-first', sent_today: 1 })
    const second = mailboxWith({ id: 'm-second', sent_today: 5 })
    listMailboxesByIdsMock.mockResolvedValue([first, second])
    claimMailboxSendMock
      .mockResolvedValueOnce(null) // m-first at cap → skip
      .mockResolvedValueOnce({ ...second, sent_today: 6 }) // m-second claimed
    getMailboxProviderMock.mockReturnValue(okProvider())

    const result = await sendViaMailbox({} as never, { ...baseInput, mailboxIds: ['m-first', 'm-second'] })

    expect(claimMailboxSendMock).toHaveBeenNthCalledWith(1, expect.anything(), 'm-first', 50)
    expect(claimMailboxSendMock).toHaveBeenNthCalledWith(2, expect.anything(), 'm-second', 50)
    expect(result.mailboxId).toBe('m-second')
  })

  it('should still return the send result when persisting the refreshed token fails', async () => {
    listMailboxesByIdsMock.mockResolvedValue([mailbox])
    claimMailboxSendMock.mockResolvedValue({ ...mailbox, sent_today: 1 })
    getMailboxProviderMock.mockReturnValue(okProvider())
    updateMailboxOauthMock.mockRejectedValue(new Error('db unreachable'))

    const result = await sendViaMailbox({} as never, baseInput)

    expect(result).toEqual({ mailboxId: 'm1', providerMessageId: 'pm1', threadId: 'thr1' })
    expect(logEventSafeMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'mailbox.oauth_persist_failed' }),
    )
  })

  it('should skip unhealthy mailboxes entirely, never attempting to claim them', async () => {
    const blocked = mailboxWith({ id: 'm-blocked', sent_today: 0, health: 'blocked' })
    const healthy = mailboxWith({ id: 'm-healthy', sent_today: 9 })
    listMailboxesByIdsMock.mockResolvedValue([blocked, healthy])
    claimMailboxSendMock.mockResolvedValue({ ...healthy, sent_today: 10 })
    getMailboxProviderMock.mockReturnValue(okProvider())

    const result = await sendViaMailbox({} as never, { ...baseInput, mailboxIds: ['m-blocked', 'm-healthy'] })

    expect(claimMailboxSendMock).toHaveBeenCalledTimes(1)
    expect(claimMailboxSendMock).toHaveBeenCalledWith(expect.anything(), 'm-healthy', 50)
    expect(result.mailboxId).toBe('m-healthy')
  })
})

describe('mailbox failure attribution', () => {
  it('should log mailbox.send.failed against the client when the provider send throws', async () => {
    listMailboxesByIdsMock.mockResolvedValue([mailbox])
    claimMailboxSendMock.mockResolvedValue(mailbox)
    const provider = okProvider()
    provider.sendEmail.mockRejectedValue(new AppError('EXTERNAL_ERROR', 'Gmail 500', {}))
    getMailboxProviderMock.mockReturnValue(provider)

    await expect(sendViaMailbox({} as never, baseInput)).rejects.toBeInstanceOf(AppError)

    expect(logErrorMock.mock.calls[0]?.[0]).toMatchObject({
      clientId: 'c1',
      type: 'mailbox.send.failed',
      source: 'mailbox',
      payload: { mailboxId: 'm1', provider: 'gmail' },
    })
  })

  it('should log mailbox.none_healthy as a warning when every mailbox is unhealthy', async () => {
    listMailboxesByIdsMock.mockResolvedValue([mailboxWith({ health: 'blocked' })])

    await expect(sendViaMailbox({} as never, baseInput)).rejects.toBeInstanceOf(AppError)

    expect(logWarnMock.mock.calls[0]?.[0]).toMatchObject({
      clientId: 'c1',
      type: 'mailbox.none_healthy',
      source: 'mailbox',
      payload: { mailboxCount: 1 },
    })
  })
})

describe('suppression gate', () => {
  it('should refuse an outreach send to any suppressed address', async () => {
    getSuppressionMock.mockResolvedValue({ email: 'a@b.com', reason: 'replied' })
    await expect(
      sendViaMailbox({} as never, { ...baseInput, to: 'a@b.com', purpose: 'outreach' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(claimMailboxSendMock).not.toHaveBeenCalled()
  })

  it('should allow a reply to an address suppressed for a non-bounce reason', async () => {
    getSuppressionMock.mockResolvedValue({ email: 'a@b.com', reason: 'price_handoff' })
    listMailboxesByIdsMock.mockResolvedValue([mailbox])
    claimMailboxSendMock.mockResolvedValue({ ...mailbox, sent_today: 1 })
    getMailboxProviderMock.mockReturnValue(okProvider())
    const result = await sendViaMailbox({} as never, { ...baseInput, to: 'a@b.com', purpose: 'reply' })
    expect(result.mailboxId).toBe('m1')
  })

  it('should refuse even a reply to a hard-bounced address', async () => {
    getSuppressionMock.mockResolvedValue({ email: 'a@b.com', reason: 'bounced' })
    await expect(
      sendViaMailbox({} as never, { ...baseInput, to: 'a@b.com', purpose: 'reply' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})

describe('warmup cap', () => {
  it('should claim against the ramped cap for a warming mailbox', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-03T12:00:00.000Z'))
    listMailboxesByIdsMock.mockResolvedValue([
      mailboxWith({ id: 'm1', warmup_profile: 'standard', warmup_started_at: '2026-07-01T00:00:00.000Z', daily_cap: 40 }),
    ])
    claimMailboxSendMock.mockResolvedValue({ ...mailbox, sent_today: 1 })
    getMailboxProviderMock.mockReturnValue(okProvider())

    await sendViaMailbox({} as never, baseInput)

    // 2 days elapsed -> 5 + 3*2 = 11, not the configured 40.
    expect(claimMailboxSendMock).toHaveBeenCalledWith(expect.anything(), 'm1', 11)
  })

  it('should claim against the configured cap for an already-warm mailbox', async () => {
    listMailboxesByIdsMock.mockResolvedValue([
      mailboxWith({ id: 'm1', warmup_profile: 'none', warmup_started_at: null, daily_cap: 40 }),
    ])
    claimMailboxSendMock.mockResolvedValue({ ...mailbox, sent_today: 1 })
    getMailboxProviderMock.mockReturnValue(okProvider())

    await sendViaMailbox({} as never, baseInput)

    expect(claimMailboxSendMock).toHaveBeenCalledWith(expect.anything(), 'm1', 40)
  })
})

describe('rotation and health', () => {
  it('should still rotate through a warning mailbox', async () => {
    listMailboxesByIdsMock.mockResolvedValue([mailboxWith({ id: 'm1', health: 'warning', daily_cap: 20 })])
    claimMailboxSendMock.mockResolvedValue({ ...mailbox, id: 'm1', health: 'warning', sent_today: 1 })
    getMailboxProviderMock.mockReturnValue(okProvider())

    const result = await sendViaMailbox({} as never, baseInput)
    expect(result.mailboxId).toBe('m1')
  })

  it('should skip a blocked mailbox entirely', async () => {
    listMailboxesByIdsMock.mockResolvedValue([mailboxWith({ id: 'm1', health: 'blocked', daily_cap: 20 })])

    await expect(sendViaMailbox({} as never, baseInput)).rejects.toMatchObject({ code: 'RATE_LIMITED' })
    expect(claimMailboxSendMock).not.toHaveBeenCalled()
  })

  it('should block a mailbox whose provider rejects the token', async () => {
    listMailboxesByIdsMock.mockResolvedValue([mailbox])
    claimMailboxSendMock.mockResolvedValue({ ...mailbox, sent_today: 1 })
    const provider = okProvider()
    provider.sendEmail.mockRejectedValue(new AppError('EXTERNAL_ERROR', 'HTTP 401', { status: 401 }))
    getMailboxProviderMock.mockReturnValue(provider)

    await expect(sendViaMailbox({} as never, baseInput)).rejects.toBeInstanceOf(AppError)
    expect(setMailboxHealthMock).toHaveBeenCalledWith(expect.anything(), 'm1', 'blocked', 'auth_failure')
  })
})

describe('sendViaMailbox attachments', () => {
  it('should forward attachments to the provider unchanged', async () => {
    const attachments = [
      { fileName: 'deck.pdf', mimeType: 'application/pdf', content: Buffer.from('X') },
    ]
    listMailboxesByIdsMock.mockResolvedValue([mailbox])
    claimMailboxSendMock.mockResolvedValue({ ...mailbox, sent_today: 1 })
    const provider = okProvider()
    getMailboxProviderMock.mockReturnValue(provider)

    await sendViaMailbox({} as never, { ...baseInput, purpose: 'reply', attachments })

    expect(provider.sendEmail).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ attachments }),
    )
  })

  it('should omit the attachments key when the caller passes none', async () => {
    listMailboxesByIdsMock.mockResolvedValue([mailbox])
    claimMailboxSendMock.mockResolvedValue({ ...mailbox, sent_today: 1 })
    const provider = okProvider()
    getMailboxProviderMock.mockReturnValue(provider)

    await sendViaMailbox({} as never, baseInput)

    // safe: the send above resolved, so exactly one call is recorded
    const sent = provider.sendEmail.mock.calls[0]![1] as Record<string, unknown>
    expect(sent).not.toHaveProperty('attachments')
  })
})
