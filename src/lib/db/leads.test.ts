import { describe, it, expect, vi } from 'vitest'
import {
  getKnownSourceIds,
  insertLeads,
  updateLeadCase,
  getVerifiedLeadCompanies,
  getLeadById,
  listActiveLeadsForCase,
  findContactedLeadByEmail,
  parkLead,
  countLeadsForCampaign,
  listOtherActiveLeadsForCollisionNotice,
} from './leads'
import { AppError } from '@/lib/errors/app-error'

function mockSupabase(overrides: {
  selectResult?: { data: unknown; error: unknown }
  verifiedCompaniesResult?: { data: unknown; error: unknown }
  upsertResult?: { data: unknown; error: unknown }
  updateResult?: { data: unknown; error: unknown }
}) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          not: () => Promise.resolve(overrides.selectResult ?? { data: [], error: null }),
          eq: () => Promise.resolve(overrides.verifiedCompaniesResult ?? { data: [], error: null }),
        }),
      }),
      upsert: () => ({
        select: () => Promise.resolve(overrides.upsertResult ?? { data: [], error: null }),
      }),
      update: () => ({
        eq: () => Promise.resolve(overrides.updateResult ?? { data: null, error: null }),
      }),
    }),
  } as never
}

describe('getKnownSourceIds', () => {
  it('should return a set of non-null source ids', async () => {
    const supabase = mockSupabase({ selectResult: { data: [{ source_id: 'a' }, { source_id: 'b' }], error: null } })
    const result = await getKnownSourceIds(supabase, 'camp1')
    expect(result).toEqual(new Set(['a', 'b']))
  })

  it('should filter out null source ids', async () => {
    const supabase = mockSupabase({ selectResult: { data: [{ source_id: 'a' }, { source_id: null }], error: null } })
    const result = await getKnownSourceIds(supabase, 'camp1')
    expect(result).toEqual(new Set(['a']))
  })

  it('should throw DB_ERROR when the query errors', async () => {
    const supabase = mockSupabase({ selectResult: { data: null, error: { message: 'boom' } } })
    await expect(getKnownSourceIds(supabase, 'camp1')).rejects.toBeInstanceOf(AppError)
  })
})

describe('insertLeads', () => {
  it('should return an empty array without calling supabase when rows is empty', async () => {
    const fromSpy = vi.fn()
    const supabase = { from: fromSpy } as never
    const result = await insertLeads(supabase, [])
    expect(result).toEqual([])
    expect(fromSpy).not.toHaveBeenCalled()
  })

  it('should return only the newly inserted rows (duplicates silently skipped)', async () => {
    const inserted = [{ id: 'l1', campaign_id: 'camp1', source_id: 'a' }]
    const supabase = mockSupabase({ upsertResult: { data: inserted, error: null } })
    const result = await insertLeads(supabase, [{ client_id: 'c1', campaign_id: 'camp1', full_name: 'A', source_id: 'a' }] as never)
    expect(result).toEqual(inserted)
  })

  it('should throw DB_ERROR when the upsert errors', async () => {
    const supabase = mockSupabase({ upsertResult: { data: null, error: { message: 'boom' } } })
    await expect(
      insertLeads(supabase, [{ client_id: 'c1', campaign_id: 'camp1', full_name: 'A' }] as never),
    ).rejects.toBeInstanceOf(AppError)
  })
})

describe('updateLeadCase', () => {
  it('should resolve when the update succeeds', async () => {
    const supabase = mockSupabase({})
    await expect(updateLeadCase(supabase, 'lead1', 'case1')).resolves.toBeUndefined()
  })

  it('should throw DB_ERROR when the update errors', async () => {
    const supabase = mockSupabase({ updateResult: { data: null, error: { message: 'boom' } } })
    await expect(updateLeadCase(supabase, 'lead1', 'case1')).rejects.toBeInstanceOf(AppError)
  })
})

describe('getVerifiedLeadCompanies', () => {
  it('should return mapped company refs for verified leads', async () => {
    const supabase = mockSupabase({
      verifiedCompaniesResult: {
        data: [
          { company_domain: 'acme.com', company_name: 'Acme' },
          { company_domain: null, company_name: 'Beta' },
        ],
        error: null,
      },
    })
    const result = await getVerifiedLeadCompanies(supabase, 'camp1')
    expect(result).toEqual([
      { companyDomain: 'acme.com', companyName: 'Acme' },
      { companyDomain: null, companyName: 'Beta' },
    ])
  })

  it('should return an empty array when there are no verified leads', async () => {
    const supabase = mockSupabase({ verifiedCompaniesResult: { data: [], error: null } })
    const result = await getVerifiedLeadCompanies(supabase, 'camp1')
    expect(result).toEqual([])
  })

  it('should throw DB_ERROR when the query errors', async () => {
    const supabase = mockSupabase({ verifiedCompaniesResult: { data: null, error: { message: 'boom' } } })
    await expect(getVerifiedLeadCompanies(supabase, 'camp1')).rejects.toBeInstanceOf(AppError)
  })
})

function mockLeadMaybe(result: { data: unknown; error: unknown }) {
  return {
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve(result) }) }) }),
  } as never
}
function mockActiveLeads(result: { data: unknown; error: unknown }) {
  return {
    from: () => ({
      select: () => ({ eq: () => ({ eq: () => ({ eq: () => Promise.resolve(result) }) }) }),
    }),
  } as never
}

describe('getLeadById', () => {
  it('should return the lead when found', async () => {
    const l = { id: 'lead1' }
    expect(await getLeadById(mockLeadMaybe({ data: l, error: null }), 'lead1')).toEqual(l)
  })

  it('should throw DB_ERROR when the query errors', async () => {
    await expect(
      getLeadById(mockLeadMaybe({ data: null, error: { message: 'boom' } }), 'lead1'),
    ).rejects.toBeInstanceOf(AppError)
  })
})

function mockContactedLead(
  leadsResult: { data: unknown; error: unknown },
  sentResult?: { data: unknown; error: unknown },
) {
  return {
    from: (table: string) => {
      if (table === 'leads') {
        return {
          select: () => ({
            eq: () => ({ eq: () => ({ not: () => Promise.resolve(leadsResult) }) }),
          }),
        }
      }
      return {
        select: () => ({
          in: () => ({ eq: () => ({ eq: () => ({ eq: () => Promise.resolve(sentResult ?? { data: [], error: null }) }) }) }),
        }),
      }
    },
  } as never
}

describe('findContactedLeadByEmail', () => {
  it('should return the lead when exactly one candidate has outbound-sent evidence via the mailbox', async () => {
    const lead = { id: 'lead1', email: 'jane@acme.com', case_id: 'case1' }
    const supabase = mockContactedLead(
      { data: [lead], error: null },
      { data: [{ lead_id: 'lead1' }], error: null },
    )
    const result = await findContactedLeadByEmail(supabase, 'c1', 'jane@acme.com', 'm1')
    expect(result).toEqual(lead)
  })

  it('should return null when no case-attached lead matches the address', async () => {
    const supabase = mockContactedLead({ data: [], error: null })
    const result = await findContactedLeadByEmail(supabase, 'c1', 'jane@acme.com', 'm1')
    expect(result).toBeNull()
  })

  it('should return null when a candidate exists but has no outbound-sent evidence', async () => {
    const lead = { id: 'lead1', email: 'jane@acme.com', case_id: 'case1' }
    const supabase = mockContactedLead({ data: [lead], error: null }, { data: [], error: null })
    const result = await findContactedLeadByEmail(supabase, 'c1', 'jane@acme.com', 'm1')
    expect(result).toBeNull()
  })

  it('should fail closed (null) when more than one candidate has outbound-sent evidence', async () => {
    const leads = [
      { id: 'lead1', email: 'jane@acme.com', case_id: 'case1' },
      { id: 'lead2', email: 'jane@acme.com', case_id: 'case2' },
    ]
    const supabase = mockContactedLead(
      { data: leads, error: null },
      { data: [{ lead_id: 'lead1' }, { lead_id: 'lead2' }], error: null },
    )
    const result = await findContactedLeadByEmail(supabase, 'c1', 'jane@acme.com', 'm1')
    expect(result).toBeNull()
  })

  it('should throw DB_ERROR when the leads query errors', async () => {
    const supabase = mockContactedLead({ data: null, error: { message: 'boom' } })
    await expect(
      findContactedLeadByEmail(supabase, 'c1', 'jane@acme.com', 'm1'),
    ).rejects.toBeInstanceOf(AppError)
  })

  it('should throw DB_ERROR when the outbound-evidence query errors', async () => {
    const lead = { id: 'lead1', email: 'jane@acme.com', case_id: 'case1' }
    const supabase = mockContactedLead({ data: [lead], error: null }, { data: null, error: { message: 'boom' } })
    await expect(
      findContactedLeadByEmail(supabase, 'c1', 'jane@acme.com', 'm1'),
    ).rejects.toBeInstanceOf(AppError)
  })
})

describe('listActiveLeadsForCase', () => {
  it('should return verified active leads when the query succeeds', async () => {
    const rows = [{ id: 'lead1', email_status: 'verified' }]
    expect(await listActiveLeadsForCase(mockActiveLeads({ data: rows, error: null }), 'case1')).toEqual(rows)
  })

  it('should throw DB_ERROR when the query errors', async () => {
    await expect(
      listActiveLeadsForCase(mockActiveLeads({ data: null, error: { message: 'boom' } }), 'case1'),
    ).rejects.toBeInstanceOf(AppError)
  })
})

describe('parkLead', () => {
  it('should set the lead status to parked', async () => {
    const update = vi.fn().mockReturnValue({ eq: () => Promise.resolve({ error: null }) })
    await parkLead({ from: () => ({ update }) } as never, 'l1')
    expect(update).toHaveBeenCalledWith({ status: 'parked' })
  })

  it('should throw DB_ERROR when the update fails', async () => {
    await expect(
      parkLead({ from: () => ({ update: () => ({ eq: () => Promise.resolve({ error: { message: 'boom' } }) }) }) } as never, 'l1'),
    ).rejects.toBeInstanceOf(AppError)
  })
})

describe('countLeadsForCampaign', () => {
  function mockCountSupabase(result: { count: number | null; error: unknown }) {
    return {
      from: () => ({ select: () => ({ eq: () => Promise.resolve(result) }) }),
    } as never
  }

  it('should return the count of leads for the campaign', async () => {
    const result = await countLeadsForCampaign(mockCountSupabase({ count: 5, error: null }), 'camp1')
    expect(result).toBe(5)
  })

  it('should return 0 when count is null', async () => {
    const result = await countLeadsForCampaign(mockCountSupabase({ count: null, error: null }), 'camp1')
    expect(result).toBe(0)
  })

  it('should throw DB_ERROR on query failure', async () => {
    await expect(
      countLeadsForCampaign(mockCountSupabase({ count: null, error: { message: 'boom' } }), 'camp1'),
    ).rejects.toBeInstanceOf(AppError)
  })
})

function mockCollisionCandidates(
  leadsResult: { data: unknown; error: unknown },
  seqResult?: { data: unknown; error: unknown },
) {
  return {
    from: (table: string) => {
      if (table === 'leads') {
        return {
          select: () => ({
            eq: () => ({ eq: () => ({ neq: () => Promise.resolve(leadsResult) }) }),
          }),
        }
      }
      return {
        select: () => ({
          in: () => ({ eq: () => Promise.resolve(seqResult ?? { data: [], error: null }) }),
        }),
      }
    },
  } as never
}

describe('listOtherActiveLeadsForCollisionNotice', () => {
  it('should return other active leads whose sequence is still active', async () => {
    const leadA = { id: 'leadA', case_id: 'case1', status: 'active' }
    const leadB = { id: 'leadB', case_id: 'case1', status: 'active' }
    const supabase = mockCollisionCandidates(
      { data: [leadA, leadB], error: null },
      { data: [{ lead_id: 'leadA' }, { lead_id: 'leadB' }], error: null },
    )
    const result = await listOtherActiveLeadsForCollisionNotice(supabase, 'case1', 'triggeringLead')
    expect(result).toEqual([leadA, leadB])
  })

  it('should exclude a candidate whose sequence is no longer active (already replied)', async () => {
    const leadA = { id: 'leadA', case_id: 'case1', status: 'active' }
    const leadB = { id: 'leadB', case_id: 'case1', status: 'active' }
    const supabase = mockCollisionCandidates(
      { data: [leadA, leadB], error: null },
      { data: [{ lead_id: 'leadA' }], error: null },
    )
    const result = await listOtherActiveLeadsForCollisionNotice(supabase, 'case1', 'triggeringLead')
    expect(result).toEqual([leadA])
  })

  it('should return an empty array without querying sequences when there are no other active leads', async () => {
    const supabase = mockCollisionCandidates({ data: [], error: null })
    const result = await listOtherActiveLeadsForCollisionNotice(supabase, 'case1', 'triggeringLead')
    expect(result).toEqual([])
  })

  it('should throw DB_ERROR when the leads query errors', async () => {
    const supabase = mockCollisionCandidates({ data: null, error: { message: 'boom' } })
    await expect(
      listOtherActiveLeadsForCollisionNotice(supabase, 'case1', 'triggeringLead'),
    ).rejects.toBeInstanceOf(AppError)
  })

  it('should throw DB_ERROR when the sequences query errors', async () => {
    const leadA = { id: 'leadA', case_id: 'case1', status: 'active' }
    const supabase = mockCollisionCandidates(
      { data: [leadA], error: null },
      { data: null, error: { message: 'boom' } },
    )
    await expect(
      listOtherActiveLeadsForCollisionNotice(supabase, 'case1', 'triggeringLead'),
    ).rejects.toBeInstanceOf(AppError)
  })
})
