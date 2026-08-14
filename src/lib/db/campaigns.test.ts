import { describe, it, expect, vi } from 'vitest'
import {
  insertCampaign,
  getCampaignById,
  listCampaignsForClient,
  getCampaignForCase,
  pauseActiveCampaignsForClient,
  resumeCampaignsForClient,
  syncReplyModeForClient,
  updateCampaignStatus,
  updateCampaignSettings,
  deleteCampaign,
  removeMailboxFromCampaigns,
  listCampaignsDueForDiscovery,
  updateCampaignNextDiscoverAt,
  recomputeCampaignNextDiscoverAt,
  recomputeClientCampaignSchedules,
} from './campaigns'
import { AppError } from '@/lib/errors/app-error'

describe('insertCampaign', () => {
  function mockSupabase(result: { data: unknown; error: unknown }) {
    return {
      from: () => ({ insert: () => ({ select: () => ({ single: () => Promise.resolve(result) }) }) }),
    } as never
  }

  it('should return the created campaign row', async () => {
    const row = { id: 'camp1', name: 'Test' }
    const result = await insertCampaign(mockSupabase({ data: row, error: null }), { client_id: 'c1', name: 'Test' } as never)
    expect(result).toEqual(row)
  })

  it('should throw DB_ERROR on insert failure', async () => {
    await expect(
      insertCampaign(mockSupabase({ data: null, error: { message: 'boom' } }), { client_id: 'c1', name: 'Test' } as never),
    ).rejects.toBeInstanceOf(AppError)
  })
})

describe('getCampaignById', () => {
  function mockSupabase(result: { data: unknown; error: unknown }) {
    return {
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve(result) }) }) }),
    } as never
  }

  it('should return the campaign row when found', async () => {
    const row = { id: 'camp1' }
    const result = await getCampaignById(mockSupabase({ data: row, error: null }), 'camp1')
    expect(result).toEqual(row)
  })

  it('should return null when not found', async () => {
    const result = await getCampaignById(mockSupabase({ data: null, error: null }), 'camp1')
    expect(result).toBeNull()
  })

  it('should throw DB_ERROR on query failure', async () => {
    await expect(
      getCampaignById(mockSupabase({ data: null, error: { message: 'boom' } }), 'camp1'),
    ).rejects.toBeInstanceOf(AppError)
  })
})

describe('listCampaignsForClient', () => {
  it('should return all campaigns when clientId is null', async () => {
    const rows = [{ id: 'camp1' }]
    const supabase = {
      from: () => ({ select: () => ({ order: () => Promise.resolve({ data: rows, error: null }) }) }),
    } as never
    const result = await listCampaignsForClient(supabase, null)
    expect(result).toEqual(rows)
  })

  it('should filter by client_id when a clientId is given', async () => {
    const rows = [{ id: 'camp1', client_id: 'c1' }]
    const supabase = {
      from: () => ({ select: () => ({ order: () => ({ eq: () => Promise.resolve({ data: rows, error: null }) }) }) }),
    } as never
    const result = await listCampaignsForClient(supabase, 'c1')
    expect(result).toEqual(rows)
  })

  it('should throw DB_ERROR on query failure', async () => {
    const supabase = {
      from: () => ({ select: () => ({ order: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }) }),
    } as never
    await expect(listCampaignsForClient(supabase, null)).rejects.toBeInstanceOf(AppError)
  })
})

describe('getCampaignForCase', () => {
  function mockCampaignForCase(result: { data: unknown; error: unknown }) {
    return {
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve(result) }) }) }),
    } as never
  }

  it('should return the joined campaign when present', async () => {
    const campaign = { id: 'camp1', reply_mode: 'auto_send' }
    const result = await getCampaignForCase(
      mockCampaignForCase({ data: { campaign }, error: null }),
      'case1',
    )
    expect(result).toEqual(campaign)
  })

  it('should return null when the case has no campaign', async () => {
    const result = await getCampaignForCase(mockCampaignForCase({ data: null, error: null }), 'case1')
    expect(result).toBeNull()
  })

  it('should throw DB_ERROR when the query errors', async () => {
    await expect(
      getCampaignForCase(mockCampaignForCase({ data: null, error: { message: 'boom' } }), 'case1'),
    ).rejects.toBeInstanceOf(AppError)
  })
})

describe('pauseActiveCampaignsForClient', () => {
  it('should resolve when the bulk update succeeds', async () => {
    const supabase = {
      from: () => ({ update: () => ({ eq: () => ({ eq: () => Promise.resolve({ error: null }) }) }) }),
    } as never
    await expect(pauseActiveCampaignsForClient(supabase, 'c1')).resolves.toBeUndefined()
  })

  it('should throw DB_ERROR when the bulk update fails', async () => {
    const supabase = {
      from: () => ({ update: () => ({ eq: () => ({ eq: () => Promise.resolve({ error: { message: 'boom' } }) }) }) }),
    } as never
    await expect(pauseActiveCampaignsForClient(supabase, 'c1')).rejects.toBeInstanceOf(AppError)
  })
})

describe('resumeCampaignsForClient', () => {
  it('should resolve when the bulk update succeeds', async () => {
    const supabase = {
      from: () => ({ update: () => ({ eq: () => ({ eq: () => Promise.resolve({ error: null }) }) }) }),
    } as never
    await expect(resumeCampaignsForClient(supabase, 'c1')).resolves.toBeUndefined()
  })

  it('should throw DB_ERROR when the bulk update fails', async () => {
    const supabase = {
      from: () => ({ update: () => ({ eq: () => ({ eq: () => Promise.resolve({ error: { message: 'boom' } }) }) }) }),
    } as never
    await expect(resumeCampaignsForClient(supabase, 'c1')).rejects.toBeInstanceOf(AppError)
  })
})

describe('syncReplyModeForClient', () => {
  it('should bulk-update every campaign for the client regardless of status', async () => {
    const update = vi.fn().mockReturnValue({ eq: () => Promise.resolve({ error: null }) })
    const supabase = { from: () => ({ update }) } as never
    await expect(syncReplyModeForClient(supabase, 'c1', 'auto_send')).resolves.toBeUndefined()
    expect(update).toHaveBeenCalledWith({ reply_mode: 'auto_send' })
  })

  it('should throw DB_ERROR when the bulk update fails', async () => {
    const supabase = {
      from: () => ({ update: () => ({ eq: () => Promise.resolve({ error: { message: 'boom' } }) }) }),
    } as never
    await expect(syncReplyModeForClient(supabase, 'c1', 'auto_send')).rejects.toBeInstanceOf(AppError)
  })
})

describe('updateCampaignStatus', () => {
  function mockSupabase(result: { data: unknown; error: unknown }) {
    return {
      from: () => ({ update: () => ({ eq: () => ({ select: () => ({ single: () => Promise.resolve(result) }) }) }) }),
    } as never
  }

  it('should return the updated campaign row', async () => {
    const row = { id: 'camp1', status: 'paused' }
    const result = await updateCampaignStatus(mockSupabase({ data: row, error: null }), 'camp1', 'paused')
    expect(result).toEqual(row)
  })

  it('should throw DB_ERROR on update failure', async () => {
    await expect(
      updateCampaignStatus(mockSupabase({ data: null, error: { message: 'boom' } }), 'camp1', 'paused'),
    ).rejects.toBeInstanceOf(AppError)
  })
})

describe('updateCampaignSettings', () => {
  function mockSupabase(result: { data: unknown; error: unknown }) {
    return {
      from: () => ({ update: () => ({ eq: () => ({ select: () => ({ single: () => Promise.resolve(result) }) }) }) }),
    } as never
  }

  const patch = {
    name: 'Updated',
    value_prop: 'New prop',
    booking_link: null,
    daily_target: 25,
    contacts_per_company: 2,
    icp: {},
    discover_time: null,
    discover_timezone: null,
    mailbox_ids: ['m1'],
    signature_name: null,
    signature_title: null,
    phone: null,
    address: null,
  }

  it('should return the updated campaign row', async () => {
    const row = { id: 'camp1', name: 'Updated' }
    const result = await updateCampaignSettings(mockSupabase({ data: row, error: null }), 'camp1', patch)
    expect(result).toEqual(row)
  })

  it('should throw DB_ERROR on update failure', async () => {
    await expect(
      updateCampaignSettings(mockSupabase({ data: null, error: { message: 'boom' } }), 'camp1', patch),
    ).rejects.toBeInstanceOf(AppError)
  })
})

describe('listCampaignsDueForDiscovery', () => {
  function mockSupabase(result: { data: unknown; error: unknown }) {
    return {
      from: () => ({ select: () => ({ eq: () => ({ lte: () => Promise.resolve(result) }) }) }),
    } as never
  }

  it('should return campaigns whose next_discover_at is due', async () => {
    const rows = [{ id: 'camp1', status: 'active', next_discover_at: '2026-06-15T06:00:00Z' }]
    const result = await listCampaignsDueForDiscovery(mockSupabase({ data: rows, error: null }), '2026-06-15T06:00:00Z')
    expect(result).toEqual(rows)
  })

  it('should throw DB_ERROR on query failure', async () => {
    await expect(
      listCampaignsDueForDiscovery(mockSupabase({ data: null, error: { message: 'boom' } }), '2026-06-15T06:00:00Z'),
    ).rejects.toBeInstanceOf(AppError)
  })
})

describe('updateCampaignNextDiscoverAt', () => {
  function mockSupabase(result: { data: unknown; error: unknown }) {
    return {
      from: () => ({ update: () => ({ eq: () => ({ select: () => ({ single: () => Promise.resolve(result) }) }) }) }),
    } as never
  }

  it('should return the updated campaign row', async () => {
    const row = { id: 'camp1', next_discover_at: '2026-06-16T06:00:00.000Z' }
    const result = await updateCampaignNextDiscoverAt(
      mockSupabase({ data: row, error: null }),
      'camp1',
      new Date('2026-06-16T06:00:00.000Z'),
    )
    expect(result).toEqual(row)
  })

  it('should throw DB_ERROR on update failure', async () => {
    await expect(
      updateCampaignNextDiscoverAt(mockSupabase({ data: null, error: { message: 'boom' } }), 'camp1', new Date()),
    ).rejects.toBeInstanceOf(AppError)
  })
})

describe('recomputeCampaignNextDiscoverAt', () => {
  function mockSupabase(campaign: unknown, client: unknown, updateResult: { data: unknown; error: unknown }) {
    return {
      from: (table: string) => {
        if (table === 'campaigns') {
          return {
            select: () => ({
              eq: () => ({ maybeSingle: () => Promise.resolve({ data: campaign, error: null }) }),
            }),
            update: () => ({ eq: () => ({ select: () => ({ single: () => Promise.resolve(updateResult) }) }) }),
          }
        }
        return {
          select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: client, error: null }) }) }),
        }
      },
    } as never
  }

  it("should use the campaign's own override when set", async () => {
    const campaign = { id: 'camp1', client_id: 'c1', discover_time: '08:00', discover_timezone: 'Europe/Istanbul' }
    const client = { id: 'c1', timezone: 'UTC', default_discover_time: '06:00' }
    const updatedRow = { id: 'camp1', next_discover_at: '2026-06-15T05:00:00.000Z' }
    const supabase = mockSupabase(campaign, client, { data: updatedRow, error: null })

    const result = await recomputeCampaignNextDiscoverAt(supabase, 'camp1', new Date('2026-06-15T00:00:00Z'))

    expect(result).toEqual(updatedRow)
  })

  it("should fall back to the client's default when the campaign has no override", async () => {
    const campaign = { id: 'camp1', client_id: 'c1', discover_time: null, discover_timezone: null }
    const client = { id: 'c1', timezone: 'UTC', default_discover_time: '06:00' }
    const updatedRow = { id: 'camp1', next_discover_at: '2026-06-15T06:00:00.000Z' }
    const supabase = mockSupabase(campaign, client, { data: updatedRow, error: null })

    const result = await recomputeCampaignNextDiscoverAt(supabase, 'camp1', new Date('2026-06-15T00:00:00Z'))

    expect(result).toEqual(updatedRow)
  })

  it('should throw NOT_FOUND when the campaign does not exist', async () => {
    const supabase = mockSupabase(null, null, { data: null, error: null })
    await expect(recomputeCampaignNextDiscoverAt(supabase, 'missing')).rejects.toBeInstanceOf(AppError)
  })

  it('should throw DB_ERROR when the campaign references a missing client', async () => {
    const campaign = { id: 'camp1', client_id: 'c1', discover_time: null, discover_timezone: null }
    const supabase = mockSupabase(campaign, null, { data: null, error: null })
    await expect(recomputeCampaignNextDiscoverAt(supabase, 'camp1')).rejects.toBeInstanceOf(AppError)
  })
})

describe('recomputeClientCampaignSchedules', () => {
  it('should recompute only active campaigns with no schedule override', async () => {
    const campaigns = [
      { id: 'camp1', client_id: 'c1', status: 'active', discover_time: null, discover_timezone: null },
      { id: 'camp2', client_id: 'c1', status: 'active', discover_time: '09:00', discover_timezone: 'UTC' },
      { id: 'camp3', client_id: 'c1', status: 'paused', discover_time: null, discover_timezone: null },
    ]
    const client = { id: 'c1', timezone: 'UTC', default_discover_time: '06:00' }
    const recomputed: string[] = []
    const supabase = {
      from: (table: string) => {
        if (table === 'campaigns') {
          return {
            select: () => ({
              order: () => ({ eq: () => Promise.resolve({ data: campaigns, error: null }) }),
              eq: () => ({ maybeSingle: () => Promise.resolve({ data: campaigns[0], error: null }) }),
            }),
            update: () => ({
              eq: () => ({
                select: () => ({
                  single: () => {
                    recomputed.push('called')
                    return Promise.resolve({ data: { id: 'camp1' }, error: null })
                  },
                }),
              }),
            }),
          }
        }
        return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: client, error: null }) }) }) }
      },
    } as never

    await recomputeClientCampaignSchedules(supabase, 'c1')

    expect(recomputed).toHaveLength(1)
  })

  it('should not throw when an individual recompute fails', async () => {
    const campaigns = [{ id: 'camp1', client_id: 'c1', status: 'active', discover_time: null, discover_timezone: null }]
    const supabase = {
      from: () => ({
        select: () => ({
          order: () => ({ eq: () => Promise.resolve({ data: campaigns, error: null }) }),
          eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }),
        }),
      }),
    } as never

    await expect(recomputeClientCampaignSchedules(supabase, 'c1')).resolves.toBeUndefined()
  })
})

describe('deleteCampaign', () => {
  function mockSupabase(result: { error: unknown }) {
    return {
      from: () => ({ delete: () => ({ eq: () => Promise.resolve(result) }) }),
    } as never
  }

  it('should resolve when the delete succeeds', async () => {
    await expect(deleteCampaign(mockSupabase({ error: null }), 'camp1')).resolves.toBeUndefined()
  })

  it('should throw DB_ERROR when the delete fails', async () => {
    await expect(deleteCampaign(mockSupabase({ error: { message: 'boom' } }), 'camp1')).rejects.toBeInstanceOf(AppError)
  })
})

describe('removeMailboxFromCampaigns', () => {
  function mockSupabase(campaigns: { id: string; mailbox_ids: string[] }[], updateError: unknown = null) {
    const update = vi.fn().mockReturnValue({ eq: () => Promise.resolve({ error: updateError }) })
    const supabase = {
      from: () => ({
        select: () => ({ order: () => ({ eq: () => Promise.resolve({ data: campaigns, error: null }) }) }),
        update,
      }),
    } as never
    return { supabase, update }
  }

  it('should filter the mailbox id out of every campaign that lists it', async () => {
    const { supabase, update } = mockSupabase([
      { id: 'camp1', mailbox_ids: ['m1', 'm2'] },
      { id: 'camp2', mailbox_ids: ['m2'] },
      { id: 'camp3', mailbox_ids: ['m1'] },
    ])

    await removeMailboxFromCampaigns(supabase, 'c1', 'm1')

    expect(update).toHaveBeenCalledTimes(2)
    expect(update).toHaveBeenCalledWith({ mailbox_ids: ['m2'] })
    expect(update).toHaveBeenCalledWith({ mailbox_ids: [] })
  })

  it('should no-op when no campaign references the mailbox', async () => {
    const { supabase, update } = mockSupabase([{ id: 'camp1', mailbox_ids: ['m2'] }])

    await removeMailboxFromCampaigns(supabase, 'c1', 'm1')

    expect(update).not.toHaveBeenCalled()
  })

  it('should throw DB_ERROR when a campaign update fails', async () => {
    const { supabase } = mockSupabase([{ id: 'camp1', mailbox_ids: ['m1'] }], { message: 'boom' })

    await expect(removeMailboxFromCampaigns(supabase, 'c1', 'm1')).rejects.toBeInstanceOf(AppError)
  })
})
