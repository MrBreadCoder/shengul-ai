import { describe, it, expect, vi } from 'vitest'
import { listAllAuthUsers } from './list-auth-users'
import { AppError } from '@/lib/errors/app-error'

function mockAdmin(pages: { users: { id: string; email?: string }[] }[]) {
  const listUsers = vi.fn()
  for (const page of pages) listUsers.mockResolvedValueOnce({ data: page, error: null })
  return { auth: { admin: { listUsers } } } as never
}

describe('listAllAuthUsers', () => {
  it('should return id/email pairs for a single page under the page size', async () => {
    const admin = mockAdmin([{ users: [{ id: 'u1', email: 'a@x.com' }, { id: 'u2', email: 'b@x.com' }] }])
    const result = await listAllAuthUsers(admin)
    expect(result).toEqual([{ id: 'u1', email: 'a@x.com' }, { id: 'u2', email: 'b@x.com' }])
  })

  it('should skip users with no email', async () => {
    const admin = mockAdmin([{ users: [{ id: 'u1', email: undefined }] }])
    const result = await listAllAuthUsers(admin)
    expect(result).toEqual([])
  })

  it('should page until a short page is returned', async () => {
    const fullPage = Array.from({ length: 200 }, (_, i) => ({ id: `u${i}`, email: `u${i}@x.com` }))
    const shortPage = [{ id: 'last', email: 'last@x.com' }]
    const admin = mockAdmin([{ users: fullPage }, { users: shortPage }])
    const result = await listAllAuthUsers(admin)
    expect(result).toHaveLength(201)
    expect(result[200]).toEqual({ id: 'last', email: 'last@x.com' })
  })

  it('should throw EXTERNAL_ERROR when the Admin API errors', async () => {
    const admin = {
      auth: { admin: { listUsers: vi.fn().mockResolvedValue({ data: null, error: { message: 'boom' } }) } },
    } as never
    await expect(listAllAuthUsers(admin)).rejects.toBeInstanceOf(AppError)
  })
})
