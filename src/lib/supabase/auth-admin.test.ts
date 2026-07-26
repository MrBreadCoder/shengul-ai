import { describe, it, expect, vi } from 'vitest'
import { banAuthUsers, unbanAuthUsers, deleteAuthUsers, deleteAuthUser, getAuthUserEmail } from './auth-admin'
import { AppError } from '@/lib/errors/app-error'

function mockAdmin(
  fn: 'updateUserById' | 'deleteUser' | 'getUserById',
  impl: (...args: unknown[]) => Promise<{ data?: unknown; error: unknown }>,
) {
  const mockFn = vi.fn(impl)
  return { admin: { auth: { admin: { [fn]: mockFn } } } as never, mockFn }
}

describe('banAuthUsers', () => {
  it('should call updateUserById with a long ban_duration for every id', async () => {
    const { admin, mockFn } = mockAdmin('updateUserById', () => Promise.resolve({ error: null }))
    await banAuthUsers(admin, ['u1', 'u2'])
    expect(mockFn).toHaveBeenCalledWith('u1', { ban_duration: '876000h' })
    expect(mockFn).toHaveBeenCalledWith('u2', { ban_duration: '876000h' })
  })

  it('should resolve when there are no ids', async () => {
    const { admin, mockFn } = mockAdmin('updateUserById', () => Promise.resolve({ error: null }))
    await expect(banAuthUsers(admin, [])).resolves.toBeUndefined()
    expect(mockFn).not.toHaveBeenCalled()
  })

  it('should throw EXTERNAL_ERROR when any ban fails', async () => {
    const { admin } = mockAdmin('updateUserById', () => Promise.resolve({ error: { message: 'boom' } }))
    await expect(banAuthUsers(admin, ['u1'])).rejects.toBeInstanceOf(AppError)
  })
})

describe('unbanAuthUsers', () => {
  it("should call updateUserById with ban_duration 'none' for every id", async () => {
    const { admin, mockFn } = mockAdmin('updateUserById', () => Promise.resolve({ error: null }))
    await unbanAuthUsers(admin, ['u1'])
    expect(mockFn).toHaveBeenCalledWith('u1', { ban_duration: 'none' })
  })

  it('should throw EXTERNAL_ERROR when any unban fails', async () => {
    const { admin } = mockAdmin('updateUserById', () => Promise.resolve({ error: { message: 'boom' } }))
    await expect(unbanAuthUsers(admin, ['u1'])).rejects.toBeInstanceOf(AppError)
  })
})

describe('deleteAuthUsers', () => {
  it('should call deleteUser for every id', async () => {
    const { admin, mockFn } = mockAdmin('deleteUser', () => Promise.resolve({ error: null }))
    await deleteAuthUsers(admin, ['u1', 'u2'])
    expect(mockFn).toHaveBeenCalledWith('u1')
    expect(mockFn).toHaveBeenCalledWith('u2')
  })

  it('should throw EXTERNAL_ERROR when any delete fails', async () => {
    const { admin } = mockAdmin('deleteUser', () => Promise.resolve({ error: { message: 'boom' } }))
    await expect(deleteAuthUsers(admin, ['u1'])).rejects.toBeInstanceOf(AppError)
  })
})

describe('deleteAuthUser', () => {
  it('should call deleteUser with the id', async () => {
    const { admin, mockFn } = mockAdmin('deleteUser', () => Promise.resolve({ error: null }))
    await deleteAuthUser(admin, 'u1')
    expect(mockFn).toHaveBeenCalledWith('u1')
  })

  it('should treat an already-deleted user as success so a retry can converge', async () => {
    const { admin } = mockAdmin('deleteUser', () =>
      Promise.resolve({ error: { status: 404, code: 'user_not_found', message: 'User not found' } }),
    )
    await expect(deleteAuthUser(admin, 'u1')).resolves.toBeUndefined()
  })

  it('should throw EXTERNAL_ERROR on any other failure', async () => {
    const { admin } = mockAdmin('deleteUser', () => Promise.resolve({ error: { status: 500, message: 'boom' } }))
    await expect(deleteAuthUser(admin, 'u1')).rejects.toBeInstanceOf(AppError)
  })
})

describe('getAuthUserEmail', () => {
  it('should return the email of the requested user', async () => {
    const { admin, mockFn } = mockAdmin('getUserById', () =>
      Promise.resolve({ data: { user: { id: 'u1', email: 'ops@acme.com' } }, error: null }),
    )
    await expect(getAuthUserEmail(admin, 'u1')).resolves.toBe('ops@acme.com')
    expect(mockFn).toHaveBeenCalledWith('u1')
  })

  it('should return null when the user does not exist', async () => {
    const { admin } = mockAdmin('getUserById', () =>
      Promise.resolve({ data: null, error: { status: 404, code: 'user_not_found', message: 'User not found' } }),
    )
    await expect(getAuthUserEmail(admin, 'u1')).resolves.toBeNull()
  })

  it('should return null when the user exists without an email', async () => {
    const { admin } = mockAdmin('getUserById', () =>
      Promise.resolve({ data: { user: { id: 'u1' } }, error: null }),
    )
    await expect(getAuthUserEmail(admin, 'u1')).resolves.toBeNull()
  })

  it('should throw EXTERNAL_ERROR on any other failure', async () => {
    const { admin } = mockAdmin('getUserById', () =>
      Promise.resolve({ data: null, error: { status: 500, message: 'boom' } }),
    )
    await expect(getAuthUserEmail(admin, 'u1')).rejects.toBeInstanceOf(AppError)
  })
})
