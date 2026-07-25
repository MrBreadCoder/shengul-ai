import { describe, it, expect, vi } from 'vitest'
import {
  insertEvent,
  listEventsForCase,
  listEventsForClient,
  countRecentErrorsByClient,
  deleteExpiredEvents,
} from './events'
import { AppError } from '@/lib/errors/app-error'

/**
 * PostgREST builders are chainable and thenable. This stub records every call
 * so a test can assert the query shape, and resolves to `result` when awaited.
 */
function queryStub(result: { data: unknown; error: unknown }) {
  const calls: Record<string, unknown[]> = {}
  const builder: Record<string, unknown> = {}
  for (const method of ['select', 'insert', 'delete', 'eq', 'in', 'lt', 'order', 'limit']) {
    builder[method] = (...args: unknown[]) => {
      calls[method] = args
      return builder
    }
  }
  builder.then = (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve)
  return { supabase: { from: () => builder } as never, calls }
}

describe('insertEvent', () => {
  it('should resolve when the insert succeeds', async () => {
    const supabase = { from: () => ({ insert: () => Promise.resolve({ error: null }) }) } as never

    await expect(
      insertEvent(supabase, { actor: 'system', type: 'x', severity: 'info', source: 'app' }),
    ).resolves.toBeUndefined()
  })

  it('should throw DB_ERROR when the insert fails', async () => {
    const supabase = {
      from: () => ({ insert: () => Promise.resolve({ error: { message: 'boom' } }) }),
    } as never

    await expect(
      insertEvent(supabase, { actor: 'system', type: 'x' }),
    ).rejects.toBeInstanceOf(AppError)
  })
})

describe('listEventsForCase', () => {
  it('should return the rows for the case', async () => {
    const rows = [{ id: 'e1' }]
    const { supabase } = queryStub({ data: rows, error: null })

    const result = await listEventsForCase(supabase, 'case1', 50)

    expect(result).toEqual(rows)
  })
})

describe('listEventsForClient', () => {
  it('should filter by client and the requested severities, newest first', async () => {
    const rows = [{ id: 'e1' }]
    const { supabase, calls } = queryStub({ data: rows, error: null })

    const result = await listEventsForClient(supabase, {
      clientId: 'c1',
      severities: ['warn', 'error'],
      source: null,
      limit: 50,
      before: null,
    })

    expect(result).toEqual(rows)
    expect(calls.eq).toEqual(['client_id', 'c1'])
    expect(calls.in).toEqual(['severity', ['warn', 'error']])
    expect(calls.order).toEqual(['created_at', { ascending: false }])
    expect(calls.limit).toEqual([50])
    expect(calls.lt).toBeUndefined()
  })

  it('should add a created_at cursor when `before` is given', async () => {
    const { supabase, calls } = queryStub({ data: [], error: null })

    await listEventsForClient(supabase, {
      clientId: 'c1',
      severities: ['error'],
      source: null,
      limit: 50,
      before: '2026-07-20T10:00:00.000Z',
    })

    expect(calls.lt).toEqual(['created_at', '2026-07-20T10:00:00.000Z'])
  })

  it('should filter by source when one is given', async () => {
    const { supabase, calls } = queryStub({ data: [], error: null })

    await listEventsForClient(supabase, {
      clientId: 'c1',
      severities: ['error'],
      source: 'apollo',
      limit: 50,
      before: null,
    })

    expect(calls.eq).toEqual(['source', 'apollo'])
  })

  it('should return an empty array when PostgREST returns no data', async () => {
    const { supabase } = queryStub({ data: null, error: null })

    const result = await listEventsForClient(supabase, {
      clientId: 'c1',
      severities: ['error'],
      source: null,
      limit: 50,
      before: null,
    })

    expect(result).toEqual([])
  })

  it('should throw DB_ERROR when the query fails', async () => {
    const { supabase } = queryStub({ data: null, error: { message: 'boom' } })

    await expect(
      listEventsForClient(supabase, {
        clientId: 'c1',
        severities: ['error'],
        source: null,
        limit: 50,
        before: null,
      }),
    ).rejects.toBeInstanceOf(AppError)
  })
})

describe('countRecentErrorsByClient', () => {
  it('should map rpc rows into a camelCase map keyed by client id', async () => {
    const supabase = {
      rpc: vi.fn().mockResolvedValue({
        data: [{ client_id: 'c1', error_count: 3, warn_count: 1 }],
        error: null,
      }),
    } as never

    const result = await countRecentErrorsByClient(supabase, '2026-07-20T00:00:00.000Z')

    expect(result.get('c1')).toEqual({ clientId: 'c1', errorCount: 3, warnCount: 1 })
  })

  it('should return an empty map when there are no rows', async () => {
    const supabase = { rpc: vi.fn().mockResolvedValue({ data: null, error: null }) } as never

    const result = await countRecentErrorsByClient(supabase, '2026-07-20T00:00:00.000Z')

    expect(result.size).toBe(0)
  })

  it('should throw DB_ERROR when the rpc fails', async () => {
    const supabase = {
      rpc: vi.fn().mockResolvedValue({ data: null, error: { message: 'boom' } }),
    } as never

    await expect(
      countRecentErrorsByClient(supabase, '2026-07-20T00:00:00.000Z'),
    ).rejects.toBeInstanceOf(AppError)
  })
})

describe('deleteExpiredEvents', () => {
  it('should purge info rows and problem rows against their own cutoffs', async () => {
    const deleteCalls: { severity: unknown; cutoff: unknown }[] = []
    const supabase = {
      from: () => ({
        delete: () => {
          const captured: { severity: unknown; cutoff: unknown } = { severity: null, cutoff: null }
          const builder: Record<string, unknown> = {}
          builder.eq = (_column: string, value: unknown) => {
            captured.severity = value
            return builder
          }
          builder.in = (_column: string, value: unknown) => {
            captured.severity = value
            return builder
          }
          builder.lt = (_column: string, value: unknown) => {
            captured.cutoff = value
            deleteCalls.push(captured)
            return builder
          }
          builder.then = (resolve: (v: unknown) => unknown) =>
            Promise.resolve({ count: 2, error: null }).then(resolve)
          return builder
        },
      }),
    } as never

    const result = await deleteExpiredEvents(supabase, new Date('2026-07-21T00:00:00.000Z'), {
      infoDays: 30,
      problemDays: 90,
    })

    expect(result).toEqual({ infoDeleted: 2, problemDeleted: 2 })
    expect(deleteCalls[0]).toEqual({ severity: 'info', cutoff: '2026-06-21T00:00:00.000Z' })
    expect(deleteCalls[1]).toEqual({ severity: ['warn', 'error'], cutoff: '2026-04-22T00:00:00.000Z' })
  })

  it('should throw DB_ERROR when a purge query fails', async () => {
    const supabase = {
      from: () => ({
        delete: () => {
          const builder: Record<string, unknown> = {}
          builder.eq = () => builder
          builder.in = () => builder
          builder.lt = () => builder
          builder.then = (resolve: (v: unknown) => unknown) =>
            Promise.resolve({ count: null, error: { message: 'boom' } }).then(resolve)
          return builder
        },
      }),
    } as never

    await expect(
      deleteExpiredEvents(supabase, new Date('2026-07-21T00:00:00.000Z'), {
        infoDays: 30,
        problemDays: 90,
      }),
    ).rejects.toBeInstanceOf(AppError)
  })
})
