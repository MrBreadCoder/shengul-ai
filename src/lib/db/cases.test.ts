import { describe, it, expect } from 'vitest'
import {
  findOrCreateCase,
  getCaseById,
  updateCaseStatus,
  updateCaseWaiting,
  listCasesByStatus,
  listStuckCases,
  countCasesForCampaign,
  claimCollisionNotice,
  claimCaseContacted,
  claimCaseContactedFrom,
  claimCaseForWriting,
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
  const updateCalls: unknown[] = []
  const supabase = {
    from: () => ({
      update: (payload: unknown) => {
        updateCalls.push(payload)
        return { eq: () => Promise.resolve(result) }
      },
    }),
  } as never
  return { supabase, updateCalls }
}
function mockByStatus(result: { data: unknown; error: unknown }) {
  const chain = {
    in: () => chain,
    or: () => chain,
    order: () => chain,
    limit: () => Promise.resolve(result),
  }
  return { from: () => ({ select: () => chain }) } as never
}

// Records the `.or()` filter string(s) and `.order()` call(s) so tests can
// assert on the exact query shape, not just the returned rows.
function mockByStatusRecording(result: { data: unknown; error: unknown }): {
  supabase: unknown
  calls: { or: string[]; order: unknown[][] }
} {
  const calls: { or: string[]; order: unknown[][] } = { or: [], order: [] }
  const chain = {
    in: () => chain,
    or: (filter: string) => {
      calls.or.push(filter)
      return chain
    },
    order: (...args: unknown[]) => {
      calls.order.push(args)
      return chain
    },
    limit: () => Promise.resolve(result),
  }
  return { supabase: { from: () => ({ select: () => chain }) }, calls }
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
    const { supabase } = mockStatusUpdate({ error: null })
    await expect(updateCaseStatus(supabase, 'case1', 'ready')).resolves.toBeUndefined()
  })

  it('should throw DB_ERROR when the update errors', async () => {
    const { supabase } = mockStatusUpdate({ error: { message: 'boom' } })
    await expect(updateCaseStatus(supabase, 'case1', 'ready')).rejects.toBeInstanceOf(AppError)
  })

  it('should always clear wait_reason, so a case leaving waiting never violates the DB check constraint', async () => {
    const { supabase, updateCalls } = mockStatusUpdate({ error: null })
    await updateCaseStatus(supabase, 'case1', 'contacted')
    expect(updateCalls[0]).toMatchObject({ status: 'contacted', wait_reason: null })
  })
})

describe('updateCaseWaiting', () => {
  it('should set status to waiting with the given reason', async () => {
    const { supabase, updateCalls } = mockStatusUpdate({ error: null })
    await expect(updateCaseWaiting(supabase, 'case1', 'mailreach_gate')).resolves.toBeUndefined()
    expect(updateCalls[0]).toMatchObject({ status: 'waiting', wait_reason: 'mailreach_gate' })
  })

  it('should throw DB_ERROR when the update errors', async () => {
    const { supabase } = mockStatusUpdate({ error: { message: 'boom' } })
    await expect(updateCaseWaiting(supabase, 'case1', 'daily_cap')).rejects.toBeInstanceOf(AppError)
  })
})

describe('listCasesByStatus', () => {
  it('should return rows when the query succeeds with a single status', async () => {
    const rows = [{ id: 'case1' }]
    expect(await listCasesByStatus(mockByStatus({ data: rows, error: null }), 'new', 100)).toEqual(rows)
  })

  it('should return rows when the query succeeds with an array of statuses', async () => {
    const rows = [{ id: 'case1' }, { id: 'case2' }]
    expect(await listCasesByStatus(mockByStatus({ data: rows, error: null }), ['ready', 'waiting'], 100)).toEqual(rows)
  })

  it('should throw DB_ERROR when the query errors', async () => {
    await expect(
      listCasesByStatus(mockByStatus({ data: null, error: { message: 'boom' } }), 'new', 100),
    ).rejects.toBeInstanceOf(AppError)
  })

  it('should order by created_at then id, so rows sharing the same created_at still get a stable, exhaustive order', async () => {
    const { supabase, calls } = mockByStatusRecording({ data: [], error: null })
    await listCasesByStatus(supabase as never, 'new', 100)
    expect(calls.order).toEqual([
      ['created_at', { ascending: true }],
      ['id', { ascending: true }],
    ])
  })

  it('should page past the boundary row with a composite (created_at, id) cursor, so ties are never skipped', async () => {
    // A plain `created_at > cursor` cursor drops any other row sharing the
    // exact boundary timestamp — real risk here, since a bulk-created batch
    // of cases can share the same created_at down to the stored precision.
    const { supabase, calls } = mockByStatusRecording({ data: [], error: null })
    await listCasesByStatus(supabase as never, 'new', 100, { createdAt: '2026-08-18T00:00:00.000Z', id: 'case-199' })
    expect(calls.or).toEqual([
      'created_at.gt.2026-08-18T00:00:00.000Z,and(created_at.eq.2026-08-18T00:00:00.000Z,id.gt.case-199)',
    ])
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

function mockContactedClaim(result: { data: unknown; error: unknown }) {
  const neqCalls: unknown[] = []
  const supabase = {
    from: () => ({
      update: () => ({
        eq: () => ({
          neq: (...a: unknown[]) => {
            neqCalls.push(a)
            return { select: () => Promise.resolve(result) }
          },
        }),
      }),
    }),
  } as never
  return { supabase, neqCalls }
}

describe('claimCaseContacted', () => {
  it('should return true when this call wins the atomic claim (status was not contacted)', async () => {
    const { supabase } = mockContactedClaim({ data: [{ id: 'case1' }], error: null })
    const result = await claimCaseContacted(supabase, 'case1')
    expect(result).toBe(true)
  })

  it('should return false when the case is already contacted (no matching row)', async () => {
    const { supabase } = mockContactedClaim({ data: [], error: null })
    const result = await claimCaseContacted(supabase, 'case1')
    expect(result).toBe(false)
  })

  it('should exclude contacted cases via a status != contacted filter, not a prior read', async () => {
    const { supabase, neqCalls } = mockContactedClaim({ data: [{ id: 'case1' }], error: null })
    await claimCaseContacted(supabase, 'case1')
    expect(neqCalls[0]).toEqual(['status', 'contacted'])
  })

  it('should throw DB_ERROR when the update errors', async () => {
    const { supabase } = mockContactedClaim({ data: null, error: { message: 'boom' } })
    await expect(claimCaseContacted(supabase, 'case1')).rejects.toBeInstanceOf(AppError)
  })
})

function mockContactedFromClaim(result: { data: unknown; error: unknown }) {
  const inCalls: unknown[] = []
  const supabase = {
    from: () => ({
      update: () => ({
        eq: () => ({
          in: (...a: unknown[]) => {
            inCalls.push(a)
            return { select: () => Promise.resolve(result) }
          },
        }),
      }),
    }),
  } as never
  return { supabase, inCalls }
}

describe('claimCaseContactedFrom', () => {
  it('should return true when this call wins the atomic claim (status was one of the given source statuses)', async () => {
    const { supabase } = mockContactedFromClaim({ data: [{ id: 'case1' }], error: null })
    const result = await claimCaseContactedFrom(supabase, 'case1', ['new', 'ready'])
    expect(result).toBe(true)
  })

  it('should return false when the case is not in one of the given source statuses (no matching row)', async () => {
    const { supabase } = mockContactedFromClaim({ data: [], error: null })
    const result = await claimCaseContactedFrom(supabase, 'case1', ['new', 'ready'])
    expect(result).toBe(false)
  })

  it('should restrict the claim to exactly the given source statuses, not every non-contacted status', async () => {
    // Load-bearing: a case already past first contact (in_conversation/
    // hot_handoff/won/lost/dead) must never be walked back to 'contacted' —
    // unlike claimCaseContacted's broad `!= contacted`, this claims only from
    // an explicit allowlist.
    const { supabase, inCalls } = mockContactedFromClaim({ data: [{ id: 'case1' }], error: null })
    await claimCaseContactedFrom(supabase, 'case1', ['new', 'researching', 'ready', 'writing', 'waiting'])
    expect(inCalls[0]).toEqual(['status', ['new', 'researching', 'ready', 'writing', 'waiting']])
  })

  it('should throw DB_ERROR when the update errors', async () => {
    const { supabase } = mockContactedFromClaim({ data: null, error: { message: 'boom' } })
    await expect(claimCaseContactedFrom(supabase, 'case1', ['new'])).rejects.toBeInstanceOf(AppError)
  })
})

function mockWritingClaim(result: { data: unknown; error: unknown }) {
  const orCalls: unknown[][] = []
  const supabase = {
    from: () => ({
      update: () => ({
        eq: () => ({
          or: (...a: unknown[]) => {
            orCalls.push(a)
            return { select: () => Promise.resolve(result) }
          },
        }),
      }),
    }),
  } as never
  return { supabase, orCalls }
}

describe('claimCaseForWriting', () => {
  it('should return the claimed row when this call wins the atomic claim', async () => {
    const row = { id: 'case1', status: 'writing' }
    const { supabase } = mockWritingClaim({ data: [row], error: null })
    const result = await claimCaseForWriting(supabase, 'case1')
    expect(result).toEqual(row)
  })

  it('should return null when no row matches (not ready, not a retryable wait)', async () => {
    const { supabase } = mockWritingClaim({ data: [], error: null })
    const result = await claimCaseForWriting(supabase, 'case1')
    expect(result).toBeNull()
  })

  it('should express the ready-or-retryable-waiting criteria as the update filter, not a prior read', async () => {
    const { supabase, orCalls } = mockWritingClaim({ data: [{ id: 'case1' }], error: null })
    await claimCaseForWriting(supabase, 'case1')
    expect(orCalls[0]?.[0]).toContain('status.eq.ready')
    expect(orCalls[0]?.[0]).toContain('wait_reason.in.(mailreach_gate,daily_cap,no_healthy_mailbox)')
  })

  it('should throw DB_ERROR when the update errors', async () => {
    const { supabase } = mockWritingClaim({ data: null, error: { message: 'boom' } })
    await expect(claimCaseForWriting(supabase, 'case1')).rejects.toBeInstanceOf(AppError)
  })
})
