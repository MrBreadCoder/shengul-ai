import { describe, it, expect, vi } from 'vitest'
import {
  upsertReport,
  getReportById,
  listReportsForClient,
  listWeeklyReportsInRange,
  getPreviousReport,
  countPriorReportsForClient,
  insertReportDelivery,
} from './reports'
import { AppError } from '@/lib/errors/app-error'

describe('upsertReport', () => {
  it('should upsert on the (client_id, type, period_start) key and return the row', async () => {
    const row = { id: 'r1', client_id: 'c1', type: 'weekly', status: 'generating' }
    const upsert = vi.fn().mockReturnValue({ select: () => ({ single: () => Promise.resolve({ data: row, error: null }) }) })
    const supabase = { from: () => ({ upsert }) } as never
    const result = await upsertReport(supabase, {
      clientId: 'c1',
      type: 'weekly',
      periodStart: '2026-08-04T00:00:00.000Z',
      periodEnd: '2026-08-11T00:00:00.000Z',
      status: 'generating',
    })
    expect(result).toEqual(row)
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ client_id: 'c1', type: 'weekly', status: 'generating' }),
      { onConflict: 'client_id,type,period_start' },
    )
  })

  it('should throw DB_ERROR when the upsert fails', async () => {
    const supabase = {
      from: () => ({
        upsert: () => ({ select: () => ({ single: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }) }),
      }),
    } as never
    await expect(
      upsertReport(supabase, { clientId: 'c1', type: 'weekly', periodStart: 'x', periodEnd: 'y', status: 'generating' }),
    ).rejects.toBeInstanceOf(AppError)
  })
})

describe('getReportById', () => {
  it('should return the report when found', async () => {
    const row = { id: 'r1' }
    const supabase = {
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: row, error: null }) }) }) }),
    } as never
    expect(await getReportById(supabase, 'r1')).toEqual(row)
  })

  it('should return null when not found', async () => {
    const supabase = {
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) }),
    } as never
    expect(await getReportById(supabase, 'missing')).toBeNull()
  })

  it('should throw DB_ERROR on query failure', async () => {
    const supabase = {
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }) }) }),
    } as never
    await expect(getReportById(supabase, 'r1')).rejects.toBeInstanceOf(AppError)
  })
})

describe('listReportsForClient', () => {
  it('should return ready/sent reports newest first', async () => {
    const rows = [{ id: 'r2' }, { id: 'r1' }]
    const supabase = {
      from: () => ({
        select: () => ({ in: () => ({ order: () => ({ limit: () => Promise.resolve({ data: rows, error: null }) }) }) }),
      }),
    } as never
    expect(await listReportsForClient(supabase, { limit: 50 })).toEqual(rows)
  })

  it('should throw DB_ERROR on query failure', async () => {
    const supabase = {
      from: () => ({
        select: () => ({ in: () => ({ order: () => ({ limit: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }) }) }),
      }),
    } as never
    await expect(listReportsForClient(supabase, { limit: 50 })).rejects.toBeInstanceOf(AppError)
  })
})

describe('listWeeklyReportsInRange', () => {
  it('should return weekly reports within the range, oldest first', async () => {
    const rows = [{ id: 'w1' }, { id: 'w2' }]
    const supabase = {
      from: () => ({
        select: () => ({
          eq: () => ({ eq: () => ({ gte: () => ({ lte: () => ({ order: () => Promise.resolve({ data: rows, error: null }) }) }) }) }),
        }),
      }),
    } as never
    const result = await listWeeklyReportsInRange(supabase, { clientId: 'c1', from: 'x', to: 'y' })
    expect(result).toEqual(rows)
  })

  it('should throw DB_ERROR on query failure', async () => {
    const supabase = {
      from: () => ({
        select: () => ({
          eq: () => ({ eq: () => ({ gte: () => ({ lte: () => ({ order: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }) }) }) }),
        }),
      }),
    } as never
    await expect(listWeeklyReportsInRange(supabase, { clientId: 'c1', from: 'x', to: 'y' })).rejects.toBeInstanceOf(AppError)
  })
})

describe('getPreviousReport', () => {
  it('should return the most recent earlier report of the same type', async () => {
    const row = { id: 'prev' }
    const supabase = {
      from: () => ({
        select: () => ({
          eq: () => ({ eq: () => ({ lt: () => ({ order: () => ({ limit: () => ({ maybeSingle: () => Promise.resolve({ data: row, error: null }) }) }) }) }) }),
        }),
      }),
    } as never
    expect(await getPreviousReport(supabase, { clientId: 'c1', type: 'weekly', beforePeriodStart: 'x' })).toEqual(row)
  })

  it('should return null when there is no earlier report', async () => {
    const supabase = {
      from: () => ({
        select: () => ({
          eq: () => ({ eq: () => ({ lt: () => ({ order: () => ({ limit: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) }) }) }),
        }),
      }),
    } as never
    expect(await getPreviousReport(supabase, { clientId: 'c1', type: 'weekly', beforePeriodStart: 'x' })).toBeNull()
  })
})

describe('countPriorReportsForClient', () => {
  it('should return the row count for the client', async () => {
    const supabase = {
      from: () => ({ select: () => ({ eq: () => Promise.resolve({ count: 3, error: null }) }) }),
    } as never
    expect(await countPriorReportsForClient(supabase, 'c1')).toBe(3)
  })

  it('should return 0 when count is null', async () => {
    const supabase = {
      from: () => ({ select: () => ({ eq: () => Promise.resolve({ count: null, error: null }) }) }),
    } as never
    expect(await countPriorReportsForClient(supabase, 'c1')).toBe(0)
  })

  it('should throw DB_ERROR on query failure', async () => {
    const supabase = {
      from: () => ({ select: () => ({ eq: () => Promise.resolve({ count: null, error: { message: 'boom' } }) }) }),
    } as never
    await expect(countPriorReportsForClient(supabase, 'c1')).rejects.toBeInstanceOf(AppError)
  })
})

describe('insertReportDelivery', () => {
  it('should resolve when the insert succeeds', async () => {
    const supabase = { from: () => ({ insert: () => Promise.resolve({ error: null }) }) } as never
    await expect(
      insertReportDelivery(supabase, { clientId: 'c1', reportId: 'r1', appUserId: 'u1', email: 'a@b.com', status: 'sent', error: null, sentAt: '2026-08-11T00:00:00.000Z' }),
    ).resolves.toBeUndefined()
  })

  it('should throw DB_ERROR when the insert fails', async () => {
    const supabase = { from: () => ({ insert: () => Promise.resolve({ error: { message: 'boom' } }) }) } as never
    await expect(
      insertReportDelivery(supabase, { clientId: 'c1', reportId: 'r1', appUserId: null, email: 'a@b.com', status: 'failed', error: 'smtp down', sentAt: null }),
    ).rejects.toBeInstanceOf(AppError)
  })
})
