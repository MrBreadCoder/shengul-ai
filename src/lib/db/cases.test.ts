import { describe, it, expect } from 'vitest'
import {
  findOrCreateCase,
  getCaseById,
  updateCaseStatus,
  listCasesByStatus,
  listStuckCases,
  countCasesForCampaign,
  claimCollisionNotice,
} from './cases'
import { AppError } from '@/lib/errors/app-error'

function mockSupabase(steps: {
  upsertResult: { data: unknown; error: unknown }
  selectResult?: { data: unknown; error: unknown }
}) {
  return {
    from: () => ({
      upsert: () => ({ select: () => Promise.resolve(steps.upsertResult) }),
      select: () => ({
        eq: () => ({
          eq: () => ({ single: () => Promise.resolve(steps.selectResult ?? { data: null, error: null }) }),
        }),
      }),
    }),
  } as never
}

const input = {
  clientId: 'client1', campaignId: 'camp1', companyName: 'Acme', companyDomain: 'acme.com', companyKey: 'acme.com',
}

describe('findOrCreateCase', () => {
  it('should return the newly created case when the upsert inserts a fresh row', async () => {
    const row = { id: 'case1', company_key: 'acme.com' }
    const supabase = mockSupabase({ upsertResult: { data: [row], error: null } })
    const result = await findOrCreateCase(supabase, input)
    expect(result).toEqual(row)
  })

  it('should look up and return the existing case when the upsert hits a conflict (ignoreDuplicates returns no row)', async () => {
    const existing = { id: 'case1', company_key: 'acme.com' }
    const supabase = mockSupabase({
      upsertResult: { data: [], error: null },
      selectResult: { data: existing, error: null },
    })
    const result = await findOrCreateCase(supabase, input)
    expect(result).toEqual(existing)
  })

  it('should throw DB_ERROR when the upsert errors', async () => {
    const supabase = mockSupabase({ upsertResult: { data: null, error: { message: 'boom' } } })
    await expect(findOrCreateCase(supabase, input)).rejects.toBeInstanceOf(AppError)
  })

  it('should throw DB_ERROR when the conflict fallback lookup finds nothing', async () => {
    const supabase = mockSupabase({
      upsertResult: { data: [], error: null },
      selectResult: { data: null, error: null },
    })
    await expect(findOrCreateCase(supabase, input)).rejects.toBeInstanceOf(AppError)
  })
})

function mockMaybe(result: { data: unknown; error: unknown }) {
  return {
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve(result) }) }) }),
  } as never
}
function mockStatusUpdate(result: { error: unknown }) {
  return { from: () => ({ update: () => ({ eq: () => Promise.resolve(result) }) }) } as never
}
function mockByStatus(result: { data: unknown; error: unknown }) {
  return {
    from: () => ({
      select: () => ({ eq: () => ({ order: () => ({ limit: () => Promise.resolve(result) }) }) }),
    }),
  } as never
}

describe('getCaseById', () => {
  it('should return the case when found', async () => {
    const c = { id: 'case1' }
    expect(await getCaseById(mockMaybe({ data: c, error: null }), 'case1')).toEqual(c)
  })

  it('should throw DB_ERROR when the query errors', async () => {
    await expect(
      getCaseById(mockMaybe({ data: null, error: { message: 'boom' } }), 'case1'),
    ).rejects.toBeInstanceOf(AppError)
  })
})

describe('updateCaseStatus', () => {
  it('should resolve when the update succeeds', async () => {
    await expect(updateCaseStatus(mockStatusUpdate({ error: null }), 'case1', 'ready')).resolves.toBeUndefined()
  })

  it('should throw DB_ERROR when the update errors', async () => {
    await expect(
      updateCaseStatus(mockStatusUpdate({ error: { message: 'boom' } }), 'case1', 'ready'),
    ).rejects.toBeInstanceOf(AppError)
  })
})

describe('listCasesByStatus', () => {
  it('should return rows when the query succeeds', async () => {
    const rows = [{ id: 'case1' }]
    expect(await listCasesByStatus(mockByStatus({ data: rows, error: null }), 'new', 100)).toEqual(rows)
  })

  it('should throw DB_ERROR when the query errors', async () => {
    await expect(
      listCasesByStatus(mockByStatus({ data: null, error: { message: 'boom' } }), 'new', 100),
    ).rejects.toBeInstanceOf(AppError)
  })
})

function mockRpc(result: { data: unknown; error: unknown }) {
  return { rpc: (...a: unknown[]) => { void a; return Promise.resolve(result) } } as never
}

describe('listStuckCases', () => {
  it('should return the rows surfaced by the find_stuck_cases RPC', async () => {
    const rows = [{ id: 'case1', status: 'researching' }]
    const result = await listStuckCases(mockRpc({ data: rows, error: null }), '2026-07-19T00:00:00.000Z', 100)
    expect(result).toEqual(rows)
  })

  it('should return an empty array when the RPC yields no rows', async () => {
    const result = await listStuckCases(mockRpc({ data: null, error: null }), '2026-07-19T00:00:00.000Z', 100)
    expect(result).toEqual([])
  })

  it('should throw DB_ERROR when the RPC errors', async () => {
    await expect(
      listStuckCases(mockRpc({ data: null, error: { message: 'boom' } }), '2026-07-19T00:00:00.000Z', 100),
    ).rejects.toBeInstanceOf(AppError)
  })
})

describe('countCasesForCampaign', () => {
  function mockCountSupabase(result: { count: number | null; error: unknown }) {
    return {
      from: () => ({ select: () => ({ eq: () => Promise.resolve(result) }) }),
    } as never
  }

  it('should return the count of cases for the campaign', async () => {
    const result = await countCasesForCampaign(mockCountSupabase({ count: 3, error: null }), 'camp1')
    expect(result).toBe(3)
  })

  it('should return 0 when count is null', async () => {
    const result = await countCasesForCampaign(mockCountSupabase({ count: null, error: null }), 'camp1')
    expect(result).toBe(0)
  })

  it('should throw DB_ERROR on query failure', async () => {
    await expect(
      countCasesForCampaign(mockCountSupabase({ count: null, error: { message: 'boom' } }), 'camp1'),
    ).rejects.toBeInstanceOf(AppError)
  })
})

function mockClaimUpdate(result: { data: unknown; error: unknown }) {
  return {
    from: () => ({
      update: () => ({ eq: () => ({ is: () => ({ select: () => Promise.resolve(result) }) }) }),
    }),
  } as never
}

describe('claimCollisionNotice', () => {
  it('should return true when this call wins the claim (row was null and got updated)', async () => {
    const supabase = mockClaimUpdate({ data: [{ id: 'case1' }], error: null })
    const result = await claimCollisionNotice(supabase, 'case1')
    expect(result).toBe(true)
  })

  it('should return false when the case was already claimed (no matching row)', async () => {
    const supabase = mockClaimUpdate({ data: [], error: null })
    const result = await claimCollisionNotice(supabase, 'case1')
    expect(result).toBe(false)
  })

  it('should throw DB_ERROR when the update errors', async () => {
    const supabase = mockClaimUpdate({ data: null, error: { message: 'boom' } })
    await expect(claimCollisionNotice(supabase, 'case1')).rejects.toBeInstanceOf(AppError)
  })
})
