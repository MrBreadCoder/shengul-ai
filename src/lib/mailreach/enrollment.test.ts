import { describe, it, expect, vi, beforeEach } from 'vitest'

const connectSmtpAccount = vi.fn()
const disconnectAccount = vi.fn()
const completeOAuthConnect = vi.fn()
const updateMailboxMailreachConnected = vi.fn()
const updateMailboxMailreachDisconnected = vi.fn()
const clearMailboxMailreachConnection = vi.fn()
const listMailboxesForClient = vi.fn()
const logEventSafe = vi.fn()

vi.mock('./client', () => ({
  connectSmtpAccount: (...args: unknown[]) => connectSmtpAccount(...args),
  disconnectAccount: (...args: unknown[]) => disconnectAccount(...args),
  completeOAuthConnect: (...args: unknown[]) => completeOAuthConnect(...args),
  buildOAuthAuthorizeUrl: (params: unknown) => `https://api.mailreach.co/api/v1/connect-account/oauth?stub=${JSON.stringify(params)}`,
}))
vi.mock('@/lib/db/mailboxes', () => ({
  updateMailboxMailreachConnected: (...args: unknown[]) => updateMailboxMailreachConnected(...args),
  updateMailboxMailreachDisconnected: (...args: unknown[]) => updateMailboxMailreachDisconnected(...args),
  clearMailboxMailreachConnection: (...args: unknown[]) => clearMailboxMailreachConnection(...args),
  listMailboxesForClient: (...args: unknown[]) => listMailboxesForClient(...args),
}))
vi.mock('@/lib/events/log-event', () => ({ logEventSafe: (...args: unknown[]) => logEventSafe(...args) }))

import { AppError } from '@/lib/errors/app-error'
import {
  connectSmtpMailbox,
  completeOAuthConnectForMailbox,
  disconnectMailbox,
  bulkDisconnectForClient,
  bulkReconnectSmtpForClient,
} from './enrollment'

const now = new Date('2026-07-29T00:00:00.000Z')

function smtpMailbox(overrides: Record<string, unknown> = {}) {
  return {
    id: 'm1',
    client_id: 'c1',
    provider: 'smtp',
    mailreach_account_id: null,
    mailreach_status: 'disconnected',
    mailreach_enabled: false,
    mailreach_started_at: null,
    oauth: {
      kind: 'smtp',
      emailAddress: 'sales@acme.com',
      username: 'sales@acme.com',
      password: 'pw',
      smtpHost: 'smtp.acme.com',
      smtpPort: 587,
      smtpSecure: false,
      imapHost: 'imap.acme.com',
      imapPort: 993,
      imapSecure: true,
    },
    ...overrides,
  } as never
}

beforeEach(() => vi.clearAllMocks())

describe('connectSmtpMailbox', () => {
  it('should connect via the API and stamp mailreach_started_at for a never-enrolled mailbox', async () => {
    connectSmtpAccount.mockResolvedValue({ accountId: 'acc_1' })
    await connectSmtpMailbox({} as never, smtpMailbox(), now)
    expect(updateMailboxMailreachConnected).toHaveBeenCalledWith({}, 'm1', {
      mailreach_account_id: 'acc_1',
      mailreach_status: 'connected',
      mailreach_started_at: now.toISOString(),
      mailreach_enabled: true,
    })
  })

  it('should preserve the original mailreach_started_at on reconnect', async () => {
    connectSmtpAccount.mockResolvedValue({ accountId: 'acc_2' })
    const original = '2026-07-01T00:00:00.000Z'
    await connectSmtpMailbox({} as never, smtpMailbox({ mailreach_started_at: original }), now)
    expect(updateMailboxMailreachConnected).toHaveBeenCalledWith(
      {},
      'm1',
      expect.objectContaining({ mailreach_started_at: original }),
    )
  })

  it('should throw VALIDATION_ERROR for a non-smtp mailbox', async () => {
    await expect(connectSmtpMailbox({} as never, smtpMailbox({ provider: 'gmail' }), now)).rejects.toBeInstanceOf(AppError)
    expect(connectSmtpAccount).not.toHaveBeenCalled()
  })
})

describe('completeOAuthConnectForMailbox', () => {
  it('should exchange the code and persist the connection', async () => {
    completeOAuthConnect.mockResolvedValue({ accountId: 'acc_3' })
    const mailbox = smtpMailbox({ provider: 'gmail' })
    await completeOAuthConnectForMailbox({} as never, mailbox, 'auth-code', now)
    expect(completeOAuthConnect).toHaveBeenCalledWith({ code: 'auth-code', provider: 'gmail' })
    expect(updateMailboxMailreachConnected).toHaveBeenCalledWith({}, 'm1', expect.objectContaining({ mailreach_enabled: true }))
  })

  it('should throw VALIDATION_ERROR for an smtp mailbox', async () => {
    await expect(completeOAuthConnectForMailbox({} as never, smtpMailbox(), 'auth-code', now)).rejects.toBeInstanceOf(AppError)
  })
})

describe('disconnectMailbox', () => {
  it('should disconnect the remote account when one is set', async () => {
    await disconnectMailbox({} as never, smtpMailbox({ mailreach_account_id: 'acc_1' }))
    expect(disconnectAccount).toHaveBeenCalledWith('acc_1')
    expect(updateMailboxMailreachDisconnected).toHaveBeenCalledWith({}, 'm1')
  })

  it('should skip the remote call when no account id is set', async () => {
    await disconnectMailbox({} as never, smtpMailbox({ mailreach_account_id: null }))
    expect(disconnectAccount).not.toHaveBeenCalled()
    expect(updateMailboxMailreachDisconnected).toHaveBeenCalledWith({}, 'm1')
  })

  it('should still clear the local connection when the vendor call fails', async () => {
    disconnectAccount.mockRejectedValue(new Error('account not found'))
    await disconnectMailbox({} as never, smtpMailbox({ mailreach_account_id: 'acc_1' }))
    expect(updateMailboxMailreachDisconnected).toHaveBeenCalledWith({}, 'm1')
    expect(logEventSafe).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'mailbox.mailreach_disconnect_failed', payload: expect.objectContaining({ mailboxId: 'm1' }) }),
    )
  })
})

describe('bulkDisconnectForClient', () => {
  it('should disconnect every currently-connected mailbox and count failures separately', async () => {
    listMailboxesForClient.mockResolvedValue([
      smtpMailbox({ id: 'm1', mailreach_status: 'connected', mailreach_account_id: 'acc_1' }),
      smtpMailbox({ id: 'm2', mailreach_status: 'connected', mailreach_account_id: 'acc_2' }),
      smtpMailbox({ id: 'm3', mailreach_status: 'disconnected' }),
    ])
    disconnectAccount.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('vendor down'))
    const result = await bulkDisconnectForClient({} as never, 'c1')
    expect(result).toEqual({ attempted: 2, succeeded: 1, failed: 1 })
  })
})

describe('bulkReconnectSmtpForClient', () => {
  it('should reconnect every enabled, disconnected smtp mailbox', async () => {
    listMailboxesForClient.mockResolvedValue([
      smtpMailbox({ id: 'm1', mailreach_enabled: true, mailreach_status: 'disconnected' }),
      smtpMailbox({ id: 'm2', provider: 'gmail', mailreach_enabled: true, mailreach_status: 'disconnected' }),
      smtpMailbox({ id: 'm3', mailreach_enabled: false }),
    ])
    connectSmtpAccount.mockResolvedValue({ accountId: 'acc_new' })
    const result = await bulkReconnectSmtpForClient({} as never, 'c1', now)
    // Only m1 qualifies: m2 is oauth (needs interactive consent, skipped), m3 isn't enabled.
    expect(result).toEqual({ attempted: 1, succeeded: 1, failed: 0 })
  })
})
