import { describe, it, expect, vi, beforeEach } from 'vitest'
import { runMailboxHealthSweep } from './mailbox-health'

const listAllMailboxes = vi.fn()
const mailboxSendStats = vi.fn()
const setMailboxHealth = vi.fn()
const logEventSafe = vi.fn()

vi.mock('@/lib/db/mailboxes', () => ({
  listAllMailboxes: (...args: unknown[]) => listAllMailboxes(...args),
  mailboxSendStats: (...args: unknown[]) => mailboxSendStats(...args),
  setMailboxHealth: (...args: unknown[]) => setMailboxHealth(...args),
}))
vi.mock('@/lib/events/log-event', () => ({
  logEventSafe: (...args: unknown[]) => logEventSafe(...args),
}))

const supabase = {} as never
const NOW = new Date('2026-07-22T00:00:00.000Z')

beforeEach(() => {
  vi.clearAllMocks()
})

describe('runMailboxHealthSweep', () => {
  it('should block a mailbox whose hard-bounce rate crossed the block threshold', async () => {
    listAllMailboxes.mockResolvedValue([{ id: 'm1', client_id: 'c1', health: 'ok', email_address: 'a@b.com' }])
    mailboxSendStats.mockResolvedValue(new Map([['m1', { sentCount: 100, bouncedCount: 6 }]]))

    const summary = await runMailboxHealthSweep(supabase, { now: NOW })

    expect(setMailboxHealth).toHaveBeenCalledWith(supabase, 'm1', 'blocked', 'bounce_rate_high')
    expect(summary).toEqual({ evaluated: 1, changed: 1 })
  })

  it('should leave a healthy mailbox untouched', async () => {
    listAllMailboxes.mockResolvedValue([{ id: 'm1', client_id: 'c1', health: 'ok', email_address: 'a@b.com' }])
    mailboxSendStats.mockResolvedValue(new Map([['m1', { sentCount: 100, bouncedCount: 1 }]]))

    const summary = await runMailboxHealthSweep(supabase, { now: NOW })

    expect(setMailboxHealth).not.toHaveBeenCalled()
    expect(summary).toEqual({ evaluated: 1, changed: 0 })
  })

  it('should treat a mailbox with no rows in the window as zero sends', async () => {
    listAllMailboxes.mockResolvedValue([{ id: 'm1', client_id: 'c1', health: 'ok', email_address: 'a@b.com' }])
    mailboxSendStats.mockResolvedValue(new Map())

    const summary = await runMailboxHealthSweep(supabase, { now: NOW })

    expect(setMailboxHealth).not.toHaveBeenCalled()
    expect(summary).toEqual({ evaluated: 1, changed: 0 })
  })

  it('should query stats over the configured window', async () => {
    listAllMailboxes.mockResolvedValue([])
    mailboxSendStats.mockResolvedValue(new Map())

    await runMailboxHealthSweep(supabase, { now: NOW })

    expect(mailboxSendStats).toHaveBeenCalledWith(supabase, new Date('2026-07-15T00:00:00.000Z'))
  })

  it('should log every health change', async () => {
    listAllMailboxes.mockResolvedValue([{ id: 'm1', client_id: 'c1', health: 'warning', email_address: 'a@b.com' }])
    mailboxSendStats.mockResolvedValue(new Map([['m1', { sentCount: 100, bouncedCount: 0 }]]))

    await runMailboxHealthSweep(supabase, { now: NOW })

    expect(setMailboxHealth).toHaveBeenCalledWith(supabase, 'm1', 'ok', 'bounce_rate_normal')
    expect(logEventSafe).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'mailbox.health_changed', clientId: 'c1' }),
    )
  })
})
