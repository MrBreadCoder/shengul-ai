import { describe, it, expect, vi, beforeEach } from 'vitest'

const listMailreachConnectedMailboxes = vi.fn()
const updateMailboxMailreachStats = vi.fn()
const getAccount = vi.fn()
const getAccountStats = vi.fn()
const resolveMailreachApiKey = vi.fn((clientId: string) => `key-for-${clientId}`)

vi.mock('@/lib/db/mailboxes', () => ({
  listMailreachConnectedMailboxes: (...args: unknown[]) => listMailreachConnectedMailboxes(...args),
  updateMailboxMailreachStats: (...args: unknown[]) => updateMailboxMailreachStats(...args),
}))
vi.mock('@/lib/mailreach/client', () => ({
  getAccount: (...args: unknown[]) => getAccount(...args),
  getAccountStats: (...args: unknown[]) => getAccountStats(...args),
}))
vi.mock('@/lib/mailreach/client-api-keys', () => ({
  resolveMailreachApiKey: (...args: unknown[]) => resolveMailreachApiKey(...(args as [string])),
}))
vi.mock('@/lib/events/log-event', () => ({ logEventSafe: () => Promise.resolve() }))

import { runMailreachStatsSync } from './mailreach-sync'

const now = new Date('2026-07-29T00:00:00.000Z')
const statsPayload = { totalMessagesSent: 120, totalMessagesReceived: 95, totalSpam: 2, currentConversationsRunning: 8 }

beforeEach(() => vi.clearAllMocks())

describe('runMailreachStatsSync', () => {
  it('should sync every connected mailbox and report zero failures', async () => {
    listMailreachConnectedMailboxes.mockResolvedValue([
      { id: 'm1', client_id: 'c1', mailreach_account_id: 'acc_1' },
      { id: 'm2', client_id: 'c1', mailreach_account_id: 'acc_2' },
    ])
    getAccount.mockResolvedValue({ reputationScore: 90 })
    getAccountStats.mockResolvedValue(statsPayload)

    const result = await runMailreachStatsSync({} as never, { now })

    expect(result).toEqual({ evaluated: 2, failed: 0 })
    expect(updateMailboxMailreachStats).toHaveBeenCalledWith({}, 'm1', {
      reputationScore: 90,
      totalMessagesSent: 120,
      totalMessagesReceived: 95,
      totalSpam: 2,
      currentConversations: 8,
      syncedAt: now.toISOString(),
    })
    expect(updateMailboxMailreachStats).toHaveBeenCalledWith({}, 'm2', {
      reputationScore: 90,
      totalMessagesSent: 120,
      totalMessagesReceived: 95,
      totalSpam: 2,
      currentConversations: 8,
      syncedAt: now.toISOString(),
    })
    expect(getAccount).toHaveBeenCalledWith('acc_1', 'key-for-c1')
    expect(getAccountStats).toHaveBeenCalledWith('acc_1', 'key-for-c1')
  })

  it("should resolve each mailbox's api key from its own client id", async () => {
    listMailreachConnectedMailboxes.mockResolvedValue([
      { id: 'm1', client_id: 'c1', mailreach_account_id: 'acc_1' },
      { id: 'm2', client_id: 'c2', mailreach_account_id: 'acc_2' },
    ])
    getAccount.mockResolvedValue({ reputationScore: 90 })
    getAccountStats.mockResolvedValue(statsPayload)

    await runMailreachStatsSync({} as never, { now })

    expect(getAccount).toHaveBeenCalledWith('acc_1', 'key-for-c1')
    expect(getAccount).toHaveBeenCalledWith('acc_2', 'key-for-c2')
  })

  it('should count a per-mailbox failure without stopping the sweep when getAccount fails', async () => {
    listMailreachConnectedMailboxes.mockResolvedValue([
      { id: 'm1', client_id: 'c1', mailreach_account_id: 'acc_1' },
      { id: 'm2', client_id: 'c1', mailreach_account_id: 'acc_2' },
    ])
    getAccountStats.mockResolvedValue(statsPayload)
    getAccount.mockRejectedValueOnce(new Error('vendor down')).mockResolvedValueOnce({ reputationScore: 80 })

    const result = await runMailreachStatsSync({} as never, { now })

    expect(result).toEqual({ evaluated: 2, failed: 1 })
    expect(updateMailboxMailreachStats).toHaveBeenCalledTimes(1)
  })

  it('should count a per-mailbox failure without stopping the sweep when getAccountStats fails', async () => {
    listMailreachConnectedMailboxes.mockResolvedValue([
      { id: 'm1', client_id: 'c1', mailreach_account_id: 'acc_1' },
      { id: 'm2', client_id: 'c1', mailreach_account_id: 'acc_2' },
    ])
    getAccount.mockResolvedValue({ reputationScore: 80 })
    getAccountStats.mockRejectedValueOnce(new Error('vendor down')).mockResolvedValueOnce(statsPayload)

    const result = await runMailreachStatsSync({} as never, { now })

    expect(result).toEqual({ evaluated: 2, failed: 1 })
    expect(updateMailboxMailreachStats).toHaveBeenCalledTimes(1)
  })

  it('should skip a mailbox with no account id', async () => {
    listMailreachConnectedMailboxes.mockResolvedValue([{ id: 'm1', client_id: 'c1', mailreach_account_id: null }])
    const result = await runMailreachStatsSync({} as never, { now })
    expect(result).toEqual({ evaluated: 1, failed: 0 })
    expect(getAccount).not.toHaveBeenCalled()
    expect(getAccountStats).not.toHaveBeenCalled()
  })
})
