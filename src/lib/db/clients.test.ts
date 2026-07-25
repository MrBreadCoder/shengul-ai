import { describe, it, expect, vi } from 'vitest'
import {
  listClients,
  listClientsFull,
  insertClient,
  getClientById,
  listClientRoleAppUsers,
  insertAppUser,
  updateClientName,
  updateClientStatus,
  deleteClientCascade,
  updateClientWarmupProfile,
  updateClientDomain,
  updateClientLogoUrl,
} from './clients'
import { AppError } from '@/lib/errors/app-error'

describe('listClients', () => {
  it('should return the list of clients ordered by name', async () => {
    const rows = [{ id: 'c1', name: 'Acme' }]
    const supabase = {
      from: () => ({ select: () => ({ order: () => Promise.resolve({ data: rows, error: null }) }) }),
    } as never
    const result = await listClients(supabase)
    expect(result).toEqual(rows)
  })

  it('should throw DB_ERROR on query failure', async () => {
    const supabase = {
      from: () => ({ select: () => ({ order: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }) }),
    } as never
    await expect(listClients(supabase)).rejects.toBeInstanceOf(AppError)
  })
})

describe('listClientsFull', () => {
  it('should return full client rows ordered by name', async () => {
    const rows = [{ id: 'c1', name: 'Acme', status: 'active', settings: {}, created_at: 'x', updated_at: 'x' }]
    const supabase = {
      from: () => ({ select: () => ({ order: () => Promise.resolve({ data: rows, error: null }) }) }),
    } as never
    const result = await listClientsFull(supabase)
    expect(result).toEqual(rows)
  })

  it('should throw DB_ERROR on query failure', async () => {
    const supabase = {
      from: () => ({ select: () => ({ order: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }) }),
    } as never
    await expect(listClientsFull(supabase)).rejects.toBeInstanceOf(AppError)
  })
})

describe('insertClient', () => {
  it('should return the created client row', async () => {
    const row = { id: 'c1', name: 'Acme' }
    const supabase = {
      from: () => ({ insert: () => ({ select: () => ({ single: () => Promise.resolve({ data: row, error: null }) }) }) }),
    } as never
    const result = await insertClient(supabase, { name: 'Acme' })
    expect(result).toEqual(row)
  })

  it('should throw DB_ERROR on insert failure', async () => {
    const supabase = {
      from: () => ({ insert: () => ({ select: () => ({ single: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }) }) }),
    } as never
    await expect(insertClient(supabase, { name: 'Acme' })).rejects.toBeInstanceOf(AppError)
  })
})

describe('getClientById', () => {
  it('should return the client row when found', async () => {
    const row = { id: 'c1', name: 'Acme' }
    const supabase = {
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: row, error: null }) }) }) }),
    } as never
    const result = await getClientById(supabase, 'c1')
    expect(result).toEqual(row)
  })

  it('should return null when not found', async () => {
    const supabase = {
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) }),
    } as never
    const result = await getClientById(supabase, 'missing')
    expect(result).toBeNull()
  })

  it('should throw DB_ERROR on query failure', async () => {
    const supabase = {
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }) }) }),
    } as never
    await expect(getClientById(supabase, 'c1')).rejects.toBeInstanceOf(AppError)
  })
})

describe('listClientRoleAppUsers', () => {
  it('should return only client-role app_users rows', async () => {
    const rows = [{ id: 'u1', role: 'client', client_id: 'c1', created_at: 'x' }]
    const supabase = {
      from: () => ({ select: () => ({ eq: () => Promise.resolve({ data: rows, error: null }) }) }),
    } as never
    const result = await listClientRoleAppUsers(supabase)
    expect(result).toEqual(rows)
  })

  it('should throw DB_ERROR on query failure', async () => {
    const supabase = {
      from: () => ({ select: () => ({ eq: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }) }),
    } as never
    await expect(listClientRoleAppUsers(supabase)).rejects.toBeInstanceOf(AppError)
  })
})

describe('insertAppUser', () => {
  it('should resolve when the insert succeeds', async () => {
    const supabase = {
      from: () => ({ insert: () => Promise.resolve({ error: null }) }),
    } as never
    await expect(insertAppUser(supabase, { id: 'u1', role: 'client', client_id: 'c1' })).resolves.toBeUndefined()
  })

  it('should throw DB_ERROR on insert failure', async () => {
    const supabase = {
      from: () => ({ insert: () => Promise.resolve({ error: { message: 'boom' } }) }),
    } as never
    await expect(insertAppUser(supabase, { id: 'u1', role: 'client', client_id: 'c1' })).rejects.toBeInstanceOf(AppError)
  })
})

describe('updateClientName', () => {
  it('should return the renamed client row', async () => {
    const row = { id: 'c1', name: 'New Name' }
    const supabase = {
      from: () => ({ update: () => ({ eq: () => ({ select: () => ({ single: () => Promise.resolve({ data: row, error: null }) }) }) }) }),
    } as never
    const result = await updateClientName(supabase, 'c1', 'New Name')
    expect(result).toEqual(row)
  })

  it('should throw DB_ERROR on update failure', async () => {
    const supabase = {
      from: () => ({ update: () => ({ eq: () => ({ select: () => ({ single: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }) }) }) }),
    } as never
    await expect(updateClientName(supabase, 'c1', 'New Name')).rejects.toBeInstanceOf(AppError)
  })
})

describe('updateClientStatus', () => {
  it('should return the client row with the new status', async () => {
    const row = { id: 'c1', status: 'paused' }
    const supabase = {
      from: () => ({ update: () => ({ eq: () => ({ select: () => ({ single: () => Promise.resolve({ data: row, error: null }) }) }) }) }),
    } as never
    const result = await updateClientStatus(supabase, 'c1', 'paused')
    expect(result).toEqual(row)
  })

  it('should throw DB_ERROR on update failure', async () => {
    const supabase = {
      from: () => ({ update: () => ({ eq: () => ({ select: () => ({ single: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }) }) }) }),
    } as never
    await expect(updateClientStatus(supabase, 'c1', 'paused')).rejects.toBeInstanceOf(AppError)
  })
})

describe('updateClientDomain', () => {
  it('should return the client with the new domain', async () => {
    const row = { id: 'c1', domain: 'acme.com' }
    const update = vi.fn().mockReturnValue({
      eq: () => ({ select: () => ({ single: () => Promise.resolve({ data: row, error: null }) }) }),
    })
    const result = await updateClientDomain({ from: () => ({ update }) } as never, 'c1', 'acme.com')
    expect(update).toHaveBeenCalledWith({ domain: 'acme.com' })
    expect(result).toEqual(row)
  })

  it('should allow clearing the domain with null', async () => {
    const update = vi.fn().mockReturnValue({
      eq: () => ({ select: () => ({ single: () => Promise.resolve({ data: { id: 'c1', domain: null }, error: null }) }) }),
    })
    await updateClientDomain({ from: () => ({ update }) } as never, 'c1', null)
    expect(update).toHaveBeenCalledWith({ domain: null })
  })

  it('should throw DB_ERROR when the update fails', async () => {
    const update = vi.fn().mockReturnValue({
      eq: () => ({ select: () => ({ single: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }) }),
    })
    await expect(
      updateClientDomain({ from: () => ({ update }) } as never, 'c1', 'acme.com'),
    ).rejects.toBeInstanceOf(AppError)
  })
})

describe('updateClientLogoUrl', () => {
  it('should return the client with the new logo url', async () => {
    const row = { id: 'c1', logo_url: 'https://x.test/logo.png' }
    const update = vi.fn().mockReturnValue({
      eq: () => ({ select: () => ({ single: () => Promise.resolve({ data: row, error: null }) }) }),
    })
    const result = await updateClientLogoUrl({ from: () => ({ update }) } as never, 'c1', 'https://x.test/logo.png')
    expect(update).toHaveBeenCalledWith({ logo_url: 'https://x.test/logo.png' })
    expect(result).toEqual(row)
  })

  it('should allow clearing the logo with null', async () => {
    const update = vi.fn().mockReturnValue({
      eq: () => ({ select: () => ({ single: () => Promise.resolve({ data: { id: 'c1', logo_url: null }, error: null }) }) }),
    })
    await updateClientLogoUrl({ from: () => ({ update }) } as never, 'c1', null)
    expect(update).toHaveBeenCalledWith({ logo_url: null })
  })

  it('should throw DB_ERROR when the update fails', async () => {
    const update = vi.fn().mockReturnValue({
      eq: () => ({ select: () => ({ single: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }) }),
    })
    await expect(
      updateClientLogoUrl({ from: () => ({ update }) } as never, 'c1', 'https://x.test/logo.png'),
    ).rejects.toBeInstanceOf(AppError)
  })
})

describe('deleteClientCascade', () => {
  it('should resolve when the delete succeeds', async () => {
    const supabase = { from: () => ({ delete: () => ({ eq: () => Promise.resolve({ error: null }) }) }) } as never
    await expect(deleteClientCascade(supabase, 'c1')).resolves.toBeUndefined()
  })

  it('should throw DB_ERROR when the delete fails', async () => {
    const supabase = {
      from: () => ({ delete: () => ({ eq: () => Promise.resolve({ error: { message: 'boom' } }) }) }),
    } as never
    await expect(deleteClientCascade(supabase, 'c1')).rejects.toBeInstanceOf(AppError)
  })
})

describe('updateClientWarmupProfile', () => {
  it('should return the updated client', async () => {
    const row = { id: 'c1', warmup_profile: 'slow' }
    const update = vi.fn().mockReturnValue({
      eq: () => ({ select: () => ({ single: () => Promise.resolve({ data: row, error: null }) }) }),
    })
    const result = await updateClientWarmupProfile({ from: () => ({ update }) } as never, 'c1', 'slow')
    expect(update).toHaveBeenCalledWith({ warmup_profile: 'slow' })
    expect(result).toEqual(row)
  })

  it('should throw DB_ERROR when the update fails', async () => {
    const update = vi.fn().mockReturnValue({
      eq: () => ({ select: () => ({ single: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }) }),
    })
    await expect(
      updateClientWarmupProfile({ from: () => ({ update }) } as never, 'c1', 'slow'),
    ).rejects.toBeInstanceOf(AppError)
  })
})
