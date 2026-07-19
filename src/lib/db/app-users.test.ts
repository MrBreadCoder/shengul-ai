import { describe, it, expect } from 'vitest'
import { getAppUser } from './app-users'
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
