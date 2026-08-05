import { describe, it, expect, vi } from 'vitest'
import { getAppUser, updateUserLocale } from './app-users'
import { AppError } from '@/lib/errors/app-error'

function mockSupabase(result: { data: unknown; error: unknown }) {
  return {
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve(result) }) }),
    }),
  } as never
}

describe('getAppUser', () => {
  it('should return the app user row when found', async () => {
    const row = { id: 'u1', role: 'operator', client_id: null }
    const result = await getAppUser(mockSupabase({ data: row, error: null }), 'u1')
    expect(result).toEqual(row)
  })

  it('should return null when no row exists', async () => {
    const result = await getAppUser(mockSupabase({ data: null, error: null }), 'u1')
    expect(result).toBeNull()
  })

  it('should throw DB_ERROR when the query errors', async () => {
    await expect(
      getAppUser(mockSupabase({ data: null, error: { message: 'boom' } }), 'u1'),
    ).rejects.toBeInstanceOf(AppError)
  })
})

describe('updateUserLocale', () => {
  it('should persist the locale and return the updated row', async () => {
    const row = { id: 'u1', role: 'client', client_id: 'c1', locale: 'tr' }
    const update = vi.fn().mockReturnValue({
      eq: () => ({ select: () => ({ single: () => Promise.resolve({ data: row, error: null }) }) }),
    })
    const result = await updateUserLocale({ from: () => ({ update }) } as never, 'u1', 'tr')
    expect(update).toHaveBeenCalledWith({ locale: 'tr' })
    expect(result).toEqual(row)
  })

  it('should throw DB_ERROR when the update fails', async () => {
    const update = vi.fn().mockReturnValue({
      eq: () => ({ select: () => ({ single: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }) }),
    })
    await expect(
      updateUserLocale({ from: () => ({ update }) } as never, 'u1', 'tr'),
    ).rejects.toBeInstanceOf(AppError)
  })
})
