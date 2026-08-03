import { describe, it, expect, vi } from 'vitest'
import {
  insertCampaign,
  getCampaignById,
  listActiveCampaigns,
  listCampaignsForClient,
  getCampaignForCase,
  pauseActiveCampaignsForClient,
  resumeCampaignsForClient,
  syncReplyModeForClient,
  updateCampaignStatus,
  deleteCampaign,
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

describe('listActiveCampaigns', () => {
  function mockSupabase(result: { data: unknown; error: unknown }) {
    return {
      from: () => ({ select: () => ({ eq: () => Promise.resolve(result) }) }),
    } as never
  }

  it('should return the list of active campaigns', async () => {
    const rows = [{ id: 'camp1', status: 'active' }]
    const result = await listActiveCampaigns(mockSupabase({ data: rows, error: null }))
    expect(result).toEqual(rows)
  })

  it('should throw DB_ERROR on query failure', async () => {
    await expect(listActiveCampaigns(mockSupabase({ data: null, error: { message: 'boom' } }))).rejects.toBeInstanceOf(AppError)
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
