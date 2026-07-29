import { describe, it, expect, vi } from 'vitest'
import {
  insertMailbox,
  getMailboxById,
  updateMailboxOauth,
  listMailboxesByIds,
  claimMailboxSend,
  claimMailboxSendUncapped,
  resetDailyCounters,
  listAllMailboxes,
  updateInboundCursor,
  setMailboxHealth,
  mailboxSendStats,
  updateMailboxWarmup,
  updateMailboxMailreachPending,
  updateMailboxMailreachConnected,
  updateMailboxMailreachDisconnected,
  clearMailboxMailreachConnection,
  updateMailboxMailreachStats,
  listMailboxesForClient,
  listMailreachConnectedMailboxes,
} from './mailboxes'
import { AppError } from '@/lib/errors/app-error'

function mockInsert(result: { data: unknown; error: unknown }) {
  return { from: () => ({ insert: () => ({ select: () => ({ single: () => Promise.resolve(result) }) }) }) } as never
}
function mockGet(result: { data: unknown; error: unknown }) {
  return {
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve(result) }) }) }),
  } as never
}
function mockUpdate(result: { error: unknown }) {
  return { from: () => ({ update: () => ({ eq: () => Promise.resolve(result) }) }) } as never
}
// Thenable chain: .eq() returns itself so it supports both a single .eq(...)
// (unconditional write) and .eq(...).eq(...) (conditional write) call shape,
// resolving to `result` either way — mirrors Supabase's real query builder.
function mockUpdateChain(result: { error: unknown }) {
  const eqSpy = vi.fn()
  const builder = {
    eq: (...args: unknown[]) => {
      eqSpy(...args)
      return builder
    },
    then: (resolve: (v: unknown) => void) => resolve(result),
  }
  return { supabase: { from: () => ({ update: () => builder }) } as never, eqSpy }
}
function mockIn(result: { data: unknown; error: unknown }) {
  return { from: () => ({ select: () => ({ in: () => Promise.resolve(result) }) }) } as never
}
function mockRpc(result: { data: unknown; error: unknown }) {
  return { rpc: () => Promise.resolve(result) } as never
}

describe('insertMailbox', () => {
  it('should return the created mailbox row', async () => {
    const row = { id: 'm1', email_address: 'x@y.com' }
    const result = await insertMailbox(mockInsert({ data: row, error: null }), { client_id: 'c1', provider: 'gmail', email_address: 'x@y.com' } as never)
    expect(result).toEqual(row)
  })

  it('should throw DB_ERROR when the insert errors', async () => {
    await expect(
      insertMailbox(mockInsert({ data: null, error: { message: 'boom' } }), { client_id: 'c1', provider: 'gmail', email_address: 'x@y.com' } as never),
    ).rejects.toBeInstanceOf(AppError)
  })
})

describe('getMailboxById', () => {
  it('should return the mailbox when found', async () => {
    const row = { id: 'm1' }
    expect(await getMailboxById(mockGet({ data: row, error: null }), 'm1')).toEqual(row)
  })

  it('should throw DB_ERROR when the query errors', async () => {
    await expect(
      getMailboxById(mockGet({ data: null, error: { message: 'boom' } }), 'm1'),
    ).rejects.toBeInstanceOf(AppError)
  })
})

describe('updateMailboxOauth', () => {
  it('should resolve when the update succeeds', async () => {
    await expect(updateMailboxOauth(mockUpdate({ error: null }), 'm1', { accessToken: 'a' })).resolves.toBeUndefined()
  })

  it('should throw DB_ERROR when the update errors', async () => {
    await expect(
      updateMailboxOauth(mockUpdate({ error: { message: 'boom' } }), 'm1', { accessToken: 'a' }),
    ).rejects.toBeInstanceOf(AppError)
  })

  it('should filter on the previous oauth snapshot when passed (conditional write)', async () => {
    const { supabase, eqSpy } = mockUpdateChain({ error: null })
    const previous = { accessToken: 'old' }
    await expect(
      updateMailboxOauth(supabase, 'm1', { accessToken: 'new' }, previous),
    ).resolves.toBeUndefined()
    expect(eqSpy).toHaveBeenCalledWith('id', 'm1')
    expect(eqSpy).toHaveBeenCalledWith('oauth', previous)
  })

  it('should not filter on oauth when previousOauth is omitted (unconditional write)', async () => {
    const { supabase, eqSpy } = mockUpdateChain({ error: null })
    await updateMailboxOauth(supabase, 'm1', { accessToken: 'new' })
    expect(eqSpy).toHaveBeenCalledWith('id', 'm1')
    expect(eqSpy).not.toHaveBeenCalledWith('oauth', expect.anything())
  })
})

describe('listMailboxesByIds', () => {
  it('should return an empty array when given no ids', async () => {
    expect(await listMailboxesByIds(mockIn({ data: null, error: null }), [])).toEqual([])
  })

  it('should return rows when the query succeeds', async () => {
    const rows = [{ id: 'm1' }]
    expect(await listMailboxesByIds(mockIn({ data: rows, error: null }), ['m1'])).toEqual(rows)
  })

  it('should throw DB_ERROR when the query errors', async () => {
    await expect(
      listMailboxesByIds(mockIn({ data: null, error: { message: 'boom' } }), ['m1']),
    ).rejects.toBeInstanceOf(AppError)
  })
})

describe('claimMailboxSend', () => {
  it('should return the mailbox when the claim succeeds', async () => {
    const row = { id: 'm1', sent_today: 1 }
    expect(await claimMailboxSend(mockRpc({ data: [row], error: null }), 'm1', 40)).toEqual(row)
  })

  it('should return null when the cap is reached (no row)', async () => {
    expect(await claimMailboxSend(mockRpc({ data: [], error: null }), 'm1', 40)).toBeNull()
  })

  it('should throw DB_ERROR when the rpc errors', async () => {
    await expect(
      claimMailboxSend(mockRpc({ data: null, error: { message: 'boom' } }), 'm1', 40),
    ).rejects.toBeInstanceOf(AppError)
  })

  it('should pass the effective cap through to the RPC', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [{ id: 'm1' }], error: null })
    const result = await claimMailboxSend({ rpc } as never, 'm1', 8)
    expect(rpc).toHaveBeenCalledWith('claim_mailbox_send', { p_mailbox_id: 'm1', p_effective_cap: 8 })
    expect(result).toEqual({ id: 'm1' })
  })

  it('should return null when the claim is refused', async () => {
    const result = await claimMailboxSend(mockRpc({ data: [], error: null }), 'm1', 8)
    expect(result).toBeNull()
  })
})

describe('setMailboxHealth', () => {
  it('should write health, reason and a change timestamp', async () => {
    const update = vi.fn().mockReturnValue({ eq: () => Promise.resolve({ error: null }) })
    await setMailboxHealth({ from: () => ({ update }) } as never, 'm1', 'blocked', 'operator_paused')
    const patch = update.mock.calls[0]?.[0] as Record<string, unknown>
    expect(patch.health).toBe('blocked')
    expect(patch.health_reason).toBe('operator_paused')
    expect(typeof patch.health_changed_at).toBe('string')
  })

  it('should throw DB_ERROR when the update fails', async () => {
    await expect(
      setMailboxHealth(mockUpdate({ error: { message: 'boom' } }), 'm1', 'ok', null),
    ).rejects.toBeInstanceOf(AppError)
  })
})

describe('mailboxSendStats', () => {
  it('should index the rpc rows by mailbox id', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [{ mailbox_id: 'm1', sent_count: 100, bounced_count: 4 }],
      error: null,
    })
    const since = new Date('2026-07-15T00:00:00.000Z')
    const stats = await mailboxSendStats({ rpc } as never, since)
    expect(rpc).toHaveBeenCalledWith('mailbox_send_stats', { p_since: since.toISOString() })
    expect(stats.get('m1')).toEqual({ sentCount: 100, bouncedCount: 4 })
  })

  it('should return an empty map when no mailbox sent anything', async () => {
    const stats = await mailboxSendStats(mockRpc({ data: [], error: null }), new Date())
    expect(stats.size).toBe(0)
  })

  it('should throw DB_ERROR when the rpc fails', async () => {
    await expect(
      mailboxSendStats(mockRpc({ data: null, error: { message: 'boom' } }), new Date()),
    ).rejects.toBeInstanceOf(AppError)
  })
})

describe('updateMailboxWarmup', () => {
  it('should write both warmup columns', async () => {
    const update = vi.fn().mockReturnValue({ eq: () => Promise.resolve({ error: null }) })
    await updateMailboxWarmup({ from: () => ({ update }) } as never, 'm1', {
      warmup_profile: 'slow',
      warmup_started_at: '2026-07-22T00:00:00.000Z',
    })
    expect(update).toHaveBeenCalledWith({
      warmup_profile: 'slow',
      warmup_started_at: '2026-07-22T00:00:00.000Z',
    })
  })
})

describe('resetDailyCounters', () => {
  it('should resolve when the rpc succeeds', async () => {
    await expect(resetDailyCounters(mockRpc({ data: null, error: null }))).resolves.toBeUndefined()
  })

  it('should throw DB_ERROR when the rpc errors', async () => {
    await expect(
      resetDailyCounters(mockRpc({ data: null, error: { message: 'boom' } })),
    ).rejects.toBeInstanceOf(AppError)
  })
})

describe('listAllMailboxes', () => {
  it('should return every mailbox row', async () => {
    const rows = [{ id: 'm1' }, { id: 'm2' }]
    const supabase = { from: () => ({ select: () => Promise.resolve({ data: rows, error: null }) }) } as never
    const result = await listAllMailboxes(supabase)
    expect(result).toEqual(rows)
  })

  it('should throw DB_ERROR when the query errors', async () => {
    const supabase = { from: () => ({ select: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }) } as never
    await expect(listAllMailboxes(supabase)).rejects.toBeInstanceOf(AppError)
  })
})

describe('updateInboundCursor', () => {
  it('should resolve when the update succeeds', async () => {
    await expect(updateInboundCursor(mockUpdate({ error: null }), 'm1', 'cur')).resolves.toBeUndefined()
  })

  it('should throw a DB_ERROR when the update fails', async () => {
    const supabase = {
      from: () => ({ update: () => ({ eq: () => Promise.resolve({ error: { message: 'boom' } }) }) }),
    } as never
    await expect(updateInboundCursor(supabase, 'm1', 'cur')).rejects.toMatchObject({ code: 'DB_ERROR' })
  })
})

describe('claimMailboxSendUncapped', () => {
  it('should claim through the uncapped RPC and return the updated row', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [{ id: 'm1', sent_today: 99 }], error: null })
    const supabase = { rpc } as never

    const result = await claimMailboxSendUncapped(supabase, 'm1')

    expect(result).toEqual({ id: 'm1', sent_today: 99 })
    expect(rpc).toHaveBeenCalledWith('claim_mailbox_send_uncapped', { p_mailbox_id: 'm1' })
  })

  it('should return null when the mailbox is blocked', async () => {
    const supabase = { rpc: () => Promise.resolve({ data: [], error: null }) } as never
    await expect(claimMailboxSendUncapped(supabase, 'm1')).resolves.toBeNull()
  })

  it('should throw DB_ERROR when the RPC fails', async () => {
    const supabase = { rpc: () => Promise.resolve({ data: null, error: { message: 'boom' } }) } as never
    await expect(claimMailboxSendUncapped(supabase, 'm1')).rejects.toMatchObject({ code: 'DB_ERROR' })
  })
})

describe('updateMailboxMailreachPending', () => {
  it('should set status to pending', async () => {
    await expect(updateMailboxMailreachPending(mockUpdate({ error: null }), 'm1')).resolves.toBeUndefined()
  })

  it('should throw DB_ERROR when the update errors', async () => {
    await expect(updateMailboxMailreachPending(mockUpdate({ error: { message: 'boom' } }), 'm1')).rejects.toBeInstanceOf(AppError)
  })
})

describe('updateMailboxMailreachConnected', () => {
  it('should persist the account id, status, and started-at', async () => {
    await expect(
      updateMailboxMailreachConnected(mockUpdate({ error: null }), 'm1', {
        mailreach_account_id: 'acc_1',
        mailreach_status: 'connected',
        mailreach_started_at: '2026-07-29T00:00:00.000Z',
        mailreach_enabled: true,
      }),
    ).resolves.toBeUndefined()
  })

  it('should throw DB_ERROR when the update errors', async () => {
    await expect(
      updateMailboxMailreachConnected(mockUpdate({ error: { message: 'boom' } }), 'm1', {
        mailreach_account_id: 'acc_1',
        mailreach_status: 'connected',
        mailreach_started_at: '2026-07-29T00:00:00.000Z',
        mailreach_enabled: true,
      }),
    ).rejects.toBeInstanceOf(AppError)
  })
})

describe('updateMailboxMailreachDisconnected', () => {
  it('should clear the connection and the enrollment intent', async () => {
    await expect(updateMailboxMailreachDisconnected(mockUpdate({ error: null }), 'm1')).resolves.toBeUndefined()
  })
})

describe('clearMailboxMailreachConnection', () => {
  it('should clear the connection but leave enrollment intent untouched', async () => {
    await expect(clearMailboxMailreachConnection(mockUpdate({ error: null }), 'm1')).resolves.toBeUndefined()
  })
})

describe('updateMailboxMailreachStats', () => {
  it('should persist the reputation score and sync timestamp', async () => {
    await expect(
      updateMailboxMailreachStats(mockUpdate({ error: null }), 'm1', {
        reputationScore: 94,
        syncedAt: '2026-07-29T00:00:00.000Z',
      }),
    ).resolves.toBeUndefined()
  })
})

describe('listMailboxesForClient', () => {
  it('should return every mailbox for the client', async () => {
    const rows = [{ id: 'm1' }, { id: 'm2' }]
    const supabase = {
      from: () => ({ select: () => ({ eq: () => Promise.resolve({ data: rows, error: null }) }) }),
    } as never
    await expect(listMailboxesForClient(supabase, 'c1')).resolves.toEqual(rows)
  })

  it('should throw DB_ERROR when the query errors', async () => {
    const supabase = {
      from: () => ({ select: () => ({ eq: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }) }),
    } as never
    await expect(listMailboxesForClient(supabase, 'c1')).rejects.toBeInstanceOf(AppError)
  })
})

describe('listMailreachConnectedMailboxes', () => {
  it('should return every connected mailbox', async () => {
    const rows = [{ id: 'm1', mailreach_status: 'connected' }]
    const supabase = {
      from: () => ({ select: () => ({ eq: () => Promise.resolve({ data: rows, error: null }) }) }),
    } as never
    await expect(listMailreachConnectedMailboxes(supabase)).resolves.toEqual(rows)
  })
})
