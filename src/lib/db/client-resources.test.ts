import { describe, it, expect, vi } from 'vitest'
import {
  insertClientResource,
  listActiveResourcesForClient,
  listActiveResourcesForClients,
  listActiveResourcesForVisibleClients,
  getResourceById,
  getActiveResourcesByIds,
  deactivateClientResource,
} from './client-resources'

const row = {
  id: 'r1', client_id: 'c1', title: 'Deck', description: 'send on request',
  file_name: 'deck.pdf', mime_type: 'application/pdf', byte_size: 1000,
  storage_path: 'c1/x.pdf', is_active: true, created_by: 'u1', created_at: '2026-07-26T00:00:00Z',
}

describe('insertClientResource', () => {
  it('should map camelCase input onto snake_case columns', async () => {
    const insert = vi.fn().mockReturnValue({
      select: () => ({ single: () => Promise.resolve({ data: row, error: null }) }),
    })
    const supabase = { from: () => ({ insert }) } as never

    const result = await insertClientResource(supabase, {
      clientId: 'c1', createdBy: 'u1', title: 'Deck', description: 'send on request',
      fileName: 'deck.pdf', mimeType: 'application/pdf', byteSize: 1000, storagePath: 'c1/x.pdf',
    })

    expect(result).toEqual(row)
    expect(insert).toHaveBeenCalledWith({
      client_id: 'c1', created_by: 'u1', title: 'Deck', description: 'send on request',
      file_name: 'deck.pdf', mime_type: 'application/pdf', byte_size: 1000, storage_path: 'c1/x.pdf',
    })
  })

  it('should throw DB_ERROR when the insert fails', async () => {
    const supabase = {
      from: () => ({
        insert: () => ({ select: () => ({ single: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }) }),
      }),
    } as never
    await expect(
      insertClientResource(supabase, {
        clientId: 'c1', createdBy: 'u1', title: 'Deck', description: 'd',
        fileName: 'a.pdf', mimeType: 'application/pdf', byteSize: 1, storagePath: 'p',
      }),
    ).rejects.toMatchObject({ code: 'DB_ERROR' })
  })
})

describe('listActiveResourcesForClient', () => {
  it('should filter to active rows for the client, newest first, within the limit', async () => {
    const limit = vi.fn().mockResolvedValue({ data: [row], error: null })
    const order = vi.fn().mockReturnValue({ limit })
    const isActive = vi.fn().mockReturnValue({ order })
    const eq = vi.fn().mockReturnValue({ eq: isActive })
    const supabase = { from: () => ({ select: () => ({ eq }) }) } as never

    const result = await listActiveResourcesForClient(supabase, 'c1', 40)

    expect(result).toEqual([row])
    expect(eq).toHaveBeenCalledWith('client_id', 'c1')
    expect(isActive).toHaveBeenCalledWith('is_active', true)
    expect(order).toHaveBeenCalledWith('created_at', { ascending: false })
    expect(limit).toHaveBeenCalledWith(40)
  })

  it('should return [] when the query yields no rows', async () => {
    const supabase = {
      from: () => ({
        select: () => ({ eq: () => ({ eq: () => ({ order: () => ({ limit: () => Promise.resolve({ data: null, error: null }) }) }) }) }),
      }),
    } as never
    await expect(listActiveResourcesForClient(supabase, 'c1', 40)).resolves.toEqual([])
  })

  it('should throw DB_ERROR when the query fails', async () => {
    const supabase = {
      from: () => ({
        select: () => ({ eq: () => ({ eq: () => ({ order: () => ({ limit: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }) }) }) }),
      }),
    } as never
    await expect(listActiveResourcesForClient(supabase, 'c1', 40)).rejects.toMatchObject({
      code: 'DB_ERROR',
    })
  })
})

describe('listActiveResourcesForClients', () => {
  // A per-client query rather than one shared ceiling: with a shared ceiling the
  // busiest client eats it and every other picker renders empty.
  function supabaseReturning(rowsByClientId: Record<string, unknown[]>): {
    supabase: never
    eq: ReturnType<typeof vi.fn>
    limit: ReturnType<typeof vi.fn>
  } {
    const eq = vi.fn()
    const limit = vi.fn()
    const supabase = {
      from: () => ({
        select: () => ({
          eq: (_column: string, clientId: string) => {
            eq(clientId)
            return {
              eq: () => ({
                order: () => ({
                  limit: (value: number) => {
                    limit(value)
                    return Promise.resolve({ data: rowsByClientId[clientId] ?? [], error: null })
                  },
                }),
              }),
            }
          },
        }),
      }),
    } as never
    return { supabase, eq, limit }
  }

  it('should key each client own rows by client id', async () => {
    const other = { ...row, id: 'r2', client_id: 'c2' }
    const { supabase } = supabaseReturning({ c1: [row], c2: [other] })

    const result = await listActiveResourcesForClients(supabase, ['c1', 'c2'], 40)

    expect(result.get('c1')).toEqual([row])
    expect(result.get('c2')).toEqual([other])
  })

  it('should give every client the full limit rather than sharing one ceiling', async () => {
    const { supabase, limit } = supabaseReturning({ c1: [row] })

    await listActiveResourcesForClients(supabase, ['c1', 'c2'], 40)

    expect(limit).toHaveBeenCalledTimes(2)
    expect(limit).toHaveBeenNthCalledWith(1, 40)
    expect(limit).toHaveBeenNthCalledWith(2, 40)
  })

  it('should query each client once even when an id repeats', async () => {
    const { supabase, eq } = supabaseReturning({ c1: [row] })

    const result = await listActiveResourcesForClients(supabase, ['c1', 'c1', 'c1'], 40)

    expect(eq).toHaveBeenCalledTimes(1)
    expect(result.size).toBe(1)
  })

  it('should return an empty map without querying when there are no clients', async () => {
    const { supabase, eq } = supabaseReturning({})

    await expect(listActiveResourcesForClients(supabase, [], 40)).resolves.toEqual(new Map())
    expect(eq).not.toHaveBeenCalled()
  })
})

describe('listActiveResourcesForVisibleClients', () => {
  it('should not filter by client so RLS decides what the caller sees', async () => {
    const limit = vi.fn().mockResolvedValue({ data: [row], error: null })
    const order = vi.fn().mockReturnValue({ limit })
    const eq = vi.fn().mockReturnValue({ order })
    const supabase = { from: () => ({ select: () => ({ eq }) }) } as never

    const result = await listActiveResourcesForVisibleClients(supabase, 40)

    expect(result).toEqual([row])
    expect(eq).toHaveBeenCalledTimes(1)
    expect(eq).toHaveBeenCalledWith('is_active', true)
  })

  it('should return [] when the query yields no rows', async () => {
    const supabase = {
      from: () => ({
        select: () => ({ eq: () => ({ order: () => ({ limit: () => Promise.resolve({ data: null, error: null }) }) }) }),
      }),
    } as never
    await expect(listActiveResourcesForVisibleClients(supabase, 40)).resolves.toEqual([])
  })

  it('should throw DB_ERROR when the query fails', async () => {
    const supabase = {
      from: () => ({
        select: () => ({ eq: () => ({ order: () => ({ limit: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }) }) }),
      }),
    } as never
    await expect(listActiveResourcesForVisibleClients(supabase, 40)).rejects.toMatchObject({
      code: 'DB_ERROR',
    })
  })
})

describe('getActiveResourcesByIds', () => {
  it('should return [] without querying when ids is empty', async () => {
    const from = vi.fn()
    const supabase = { from } as never
    await expect(getActiveResourcesByIds(supabase, 'c1', [])).resolves.toEqual([])
    expect(from).not.toHaveBeenCalled()
  })

  it('should scope the lookup to the client so a foreign id cannot resolve', async () => {
    const inFilter = vi.fn().mockResolvedValue({ data: [row], error: null })
    const isActive = vi.fn().mockReturnValue({ in: inFilter })
    const eq = vi.fn().mockReturnValue({ eq: isActive })
    const supabase = { from: () => ({ select: () => ({ eq }) }) } as never

    await getActiveResourcesByIds(supabase, 'c1', ['r1', 'r-other'])

    expect(eq).toHaveBeenCalledWith('client_id', 'c1')
    expect(isActive).toHaveBeenCalledWith('is_active', true)
    expect(inFilter).toHaveBeenCalledWith('id', ['r1', 'r-other'])
  })

  it('should return [] when none of the ids resolved for this client', async () => {
    const supabase = {
      from: () => ({
        select: () => ({ eq: () => ({ eq: () => ({ in: () => Promise.resolve({ data: null, error: null }) }) }) }),
      }),
    } as never
    await expect(getActiveResourcesByIds(supabase, 'c1', ['r-foreign'])).resolves.toEqual([])
  })

  it('should throw DB_ERROR when the query fails', async () => {
    const supabase = {
      from: () => ({
        select: () => ({ eq: () => ({ eq: () => ({ in: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }) }) }),
      }),
    } as never
    await expect(getActiveResourcesByIds(supabase, 'c1', ['r1'])).rejects.toMatchObject({
      code: 'DB_ERROR',
    })
  })
})

describe('getResourceById', () => {
  it('should return the row when one matches', async () => {
    const supabase = {
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: row, error: null }) }) }) }),
    } as never
    await expect(getResourceById(supabase, 'r1')).resolves.toEqual(row)
  })

  it('should return null when no row matches', async () => {
    const supabase = {
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) }),
    } as never
    await expect(getResourceById(supabase, 'r1')).resolves.toBeNull()
  })

  it('should throw DB_ERROR when the query fails', async () => {
    const supabase = {
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }) }) }),
    } as never
    await expect(getResourceById(supabase, 'r1')).rejects.toMatchObject({ code: 'DB_ERROR' })
  })
})

describe('deactivateClientResource', () => {
  it('should soft delete and return the row when it was still active', async () => {
    const select = vi.fn().mockResolvedValue({ data: [{ ...row, is_active: false }], error: null })
    const isActive = vi.fn().mockReturnValue({ select })
    const eq = vi.fn().mockReturnValue({ eq: isActive })
    const update = vi.fn().mockReturnValue({ eq })
    const supabase = { from: () => ({ update }) } as never

    const result = await deactivateClientResource(supabase, 'r1')

    expect(result?.is_active).toBe(false)
    expect(update).toHaveBeenCalledWith({ is_active: false })
    expect(eq).toHaveBeenCalledWith('id', 'r1')
    expect(isActive).toHaveBeenCalledWith('is_active', true)
  })

  it('should return null when the row was already deactivated', async () => {
    const supabase = {
      from: () => ({ update: () => ({ eq: () => ({ eq: () => ({ select: () => Promise.resolve({ data: [], error: null }) }) }) }) }),
    } as never
    await expect(deactivateClientResource(supabase, 'r1')).resolves.toBeNull()
  })

  it('should throw DB_ERROR when the update fails', async () => {
    const supabase = {
      from: () => ({
        update: () => ({ eq: () => ({ eq: () => ({ select: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }) }) }),
      }),
    } as never
    await expect(deactivateClientResource(supabase, 'r1')).rejects.toMatchObject({ code: 'DB_ERROR' })
  })
})
