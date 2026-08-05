import { describe, it, expect, vi, beforeEach } from 'vitest'

const requireUser = vi.fn()
const updateUserLocale = vi.fn()
const logEvent = vi.fn()
const revalidatePath = vi.fn()

vi.mock('@/lib/auth/require-user', () => ({ requireUser: (...a: unknown[]) => requireUser(...a) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/db/app-users', () => ({ updateUserLocale: (...a: unknown[]) => updateUserLocale(...a) }))
vi.mock('@/lib/events/log-event', () => ({ logEvent: (...a: unknown[]) => logEvent(...a) }))
vi.mock('next/cache', () => ({ revalidatePath: (...a: unknown[]) => revalidatePath(...a) }))

const { updateMyLocale } = await import('./locale-actions')

beforeEach(() => {
  vi.clearAllMocks()
  requireUser.mockResolvedValue({ appUser: { id: 'u1', role: 'client', client_id: 'c1' } })
  updateUserLocale.mockResolvedValue({ id: 'u1', locale: 'tr' })
})

describe('updateMyLocale', () => {
  it("should update the caller's own locale", async () => {
    await updateMyLocale('tr')
    expect(updateUserLocale).toHaveBeenCalledWith({}, 'u1', 'tr')
    expect(logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: 'c1', type: 'user.locale_changed', payload: { locale: 'tr' } }),
    )
    expect(revalidatePath).toHaveBeenCalledWith('/', 'layout')
  })

  it('should allow an operator (no client_id) to set their own locale', async () => {
    requireUser.mockResolvedValue({ appUser: { id: 'op1', role: 'operator', client_id: null } })
    await updateMyLocale('en')
    expect(updateUserLocale).toHaveBeenCalledWith({}, 'op1', 'en')
    expect(logEvent).toHaveBeenCalledWith(expect.objectContaining({ clientId: null }))
  })

  it('should reject an unsupported locale', async () => {
    await expect(updateMyLocale('fr' as never)).rejects.toThrow()
    expect(updateUserLocale).not.toHaveBeenCalled()
  })
})
