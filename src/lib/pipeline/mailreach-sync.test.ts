import { describe, it, expect, vi, beforeEach } from 'vitest'

const listMailreachConnectedMailboxes = vi.fn()
const updateMailboxMailreachStats = vi.fn()
const getAccountStats = vi.fn()

vi.mock('@/lib/db/mailboxes', () => ({
  listMailreachConnectedMailboxes: (...args: unknown[]) => listMailreachConnectedMailboxes(...args),
  updateMailboxMailreachStats: (...args: unknown[]) => updateMailboxMailreachStats(...args),
}))
vi.mock('@/lib/mailreach/client', () => ({ getAccountStats: (...args: unknown[]) => getAccountStats(...args) }))
vi.mock('@/lib/events/log-event', () => ({ logEventSafe: () => Promise.resolve() }))

import { runMailreachStatsSync } from './mailreach-sync'

const now = new Date('2026-07-29T00:00:00.000Z')

beforeEach(() => vi.clearAllMocks())

describe('runMailreachStatsSync', () => {
  it('should sync every connected mailbox and report zero failures', async () => {
    listMailreachConnectedMailboxes.mockResolvedValue([
      { id: 'm1', client_id: 'c1', mailreach_account_id: 'acc_1' },
      { id: 'm2', client_id: 'c1', mailreach_account_id: 'acc_2' },
    ])
    getAccountStats.mockResolvedValue({ reputationScore: 90 })

    const result = await runMailreachStatsSync({} as never, { now })

    expect(result).toEqual({ evaluated: 2, failed: 0 })
    expect(updateMailboxMailreachStats).toHaveBeenCalledWith({}, 'm1', { reputationScore: 90, syncedAt: now.toISOString() })
    expect(updateMailboxMailreachStats).toHaveBeenCalledWith({}, 'm2', { reputationScore: 90, syncedAt: now.toISOString() })
  })

  it('should count a per-mailbox failure without stopping the sweep', async () => {
    listMailreachConnectedMailboxes.mockResolvedValue([
      { id: 'm1', client_id: 'c1', mailreach_account_id: 'acc_1' },
      { id: 'm2', client_id: 'c1', mailreach_account_id: 'acc_2' },
    ])
    getAccountStats.mockRejectedValueOnce(new Error('vendor down')).mockResolvedValueOnce({ reputationScore: 80 })

    const result = await runMailreachStatsSync({} as never, { now })

    expect(result).toEqual({ evaluated: 2, failed: 1 })
    expect(updateMailboxMailreachStats).toHaveBeenCalledTimes(1)
  })

  it('should skip a mailbox with no account id', async () => {
    listMailreachConnectedMailboxes.mockResolvedValue([{ id: 'm1', client_id: 'c1', mailreach_account_id: null }])
    const result = await runMailreachStatsSync({} as never, { now })
    expect(result).toEqual({ evaluated: 1, failed: 0 })
    expect(getAccountStats).not.toHaveBeenCalled()
  })
})
