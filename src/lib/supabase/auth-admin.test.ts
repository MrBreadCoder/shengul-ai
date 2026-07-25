import { describe, it, expect, vi } from 'vitest'
import { banAuthUsers, unbanAuthUsers, deleteAuthUsers } from './auth-admin'
import { AppError } from '@/lib/errors/app-error'

function mockAdmin(fn: 'updateUserById' | 'deleteUser', impl: (...args: unknown[]) => Promise<{ error: unknown }>) {
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
