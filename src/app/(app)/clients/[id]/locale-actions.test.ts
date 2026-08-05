import { describe, it, expect, vi, beforeEach } from 'vitest'

const requireUser = vi.fn()
const getClientById = vi.fn()
const updateClientDefaultLocaleRow = vi.fn()
const logEvent = vi.fn()
const revalidatePath = vi.fn()

vi.mock('@/lib/auth/require-user', () => ({ requireUser: (...a: unknown[]) => requireUser(...a) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/db/clients', () => ({
  getClientById: (...a: unknown[]) => getClientById(...a),
  updateClientDefaultLocale: (...a: unknown[]) => updateClientDefaultLocaleRow(...a),
}))
vi.mock('@/lib/events/log-event', () => ({ logEvent: (...a: unknown[]) => logEvent(...a) }))
vi.mock('next/cache', () => ({ revalidatePath: (...a: unknown[]) => revalidatePath(...a) }))

const { updateClientDefaultLocale } = await import('./locale-actions')

beforeEach(() => {
  vi.clearAllMocks()
  requireUser.mockResolvedValue({ appUser: { id: 'op1', role: 'operator', client_id: null } })
  getClientById.mockResolvedValue({ id: 'c1', name: 'Acme', default_locale: 'en' })
  updateClientDefaultLocaleRow.mockResolvedValue({ id: 'c1', name: 'Acme', default_locale: 'tr' })
})

describe('updateClientDefaultLocale', () => {
  it('should update the client default language', async () => {
    const result = await updateClientDefaultLocale('c1', 'tr')
    expect(result).toEqual({ ok: true })
    expect(updateClientDefaultLocaleRow).toHaveBeenCalledWith({}, 'c1', 'tr')
    expect(logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: 'c1', type: 'client.default_locale_changed', payload: { from: 'en', to: 'tr' } }),
    )
    expect(revalidatePath).toHaveBeenCalledWith('/clients/c1')
  })

  it('should reject a client-role user', async () => {
    requireUser.mockResolvedValue({ appUser: { id: 'u2', role: 'client', client_id: 'c1' } })
    const result = await updateClientDefaultLocale('c1', 'tr')
    expect(result).toEqual({ ok: false, code: 'UNAUTHORIZED' })
    expect(updateClientDefaultLocaleRow).not.toHaveBeenCalled()
  })

  it('should reject an unknown client', async () => {
    getClientById.mockResolvedValue(null)
    const result = await updateClientDefaultLocale('missing', 'tr')
    expect(result).toEqual({ ok: false, code: 'NOT_FOUND' })
  })

  it('should reject an unsupported locale', async () => {
    const result = await updateClientDefaultLocale('c1', 'fr' as never)
    expect(result).toEqual({ ok: false, code: 'VALIDATION_ERROR' })
    expect(updateClientDefaultLocaleRow).not.toHaveBeenCalled()
  })
})
