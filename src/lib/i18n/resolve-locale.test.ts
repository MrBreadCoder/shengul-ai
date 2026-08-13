import { describe, it, expect, vi, beforeEach } from 'vitest'

const getUser = vi.fn()
const getAppUser = vi.fn()
const getClientById = vi.fn()
const headersGet = vi.fn()

vi.mock('@/lib/supabase/server', () => ({
  createServerClient: () => Promise.resolve({ auth: { getUser } }),
}))
vi.mock('@/lib/db/app-users', () => ({ getAppUser: (...a: unknown[]) => getAppUser(...a) }))
vi.mock('@/lib/db/clients', () => ({ getClientById: (...a: unknown[]) => getClientById(...a) }))
vi.mock('next/headers', () => ({
  headers: () => Promise.resolve({ get: (name: string) => headersGet(name) }),
}))

const { resolveLocale } = await import('./resolve-locale')

beforeEach(() => {
  vi.clearAllMocks()
})

describe('resolveLocale', () => {
  it('should fall back to Accept-Language when there is no session', async () => {
    getUser.mockResolvedValue({ data: { user: null } })
    headersGet.mockReturnValue('tr-TR,tr;q=0.9,en;q=0.8')

    await expect(resolveLocale()).resolves.toBe('tr')
    expect(getAppUser).not.toHaveBeenCalled()
  })

  it('should default to en when Accept-Language has no supported tag', async () => {
    getUser.mockResolvedValue({ data: { user: null } })
    headersGet.mockReturnValue('fr-FR,fr;q=0.9')

    await expect(resolveLocale()).resolves.toBe('en')
  })

  it('should default to en when there is no session and no Accept-Language header', async () => {
    getUser.mockResolvedValue({ data: { user: null } })
    headersGet.mockReturnValue(null)

    await expect(resolveLocale()).resolves.toBe('en')
  })

  it("should use the user's own override when set", async () => {
    getUser.mockResolvedValue({ data: { user: { id: 'u1' } } })
    getAppUser.mockResolvedValue({ id: 'u1', role: 'client', client_id: 'c1', locale: 'tr' })

    await expect(resolveLocale()).resolves.toBe('tr')
    expect(getClientById).not.toHaveBeenCalled()
  })

  it("should fall back to the client's default when a client user has no override", async () => {
    getUser.mockResolvedValue({ data: { user: { id: 'u1' } } })
    getAppUser.mockResolvedValue({ id: 'u1', role: 'client', client_id: 'c1', locale: null })
    getClientById.mockResolvedValue({ id: 'c1', default_locale: 'tr' })

    await expect(resolveLocale()).resolves.toBe('tr')
  })

  it('should default an operator with no override to en', async () => {
    getUser.mockResolvedValue({ data: { user: { id: 'op1' } } })
    getAppUser.mockResolvedValue({ id: 'op1', role: 'operator', client_id: null, locale: null })

    await expect(resolveLocale()).resolves.toBe('en')
    expect(getClientById).not.toHaveBeenCalled()
  })

  it('should default to en when the session has no app_users row', async () => {
    getUser.mockResolvedValue({ data: { user: { id: 'ghost' } } })
    getAppUser.mockResolvedValue(null)

    await expect(resolveLocale()).resolves.toBe('en')
  })
})

const { isSupportedLocale, parseAcceptLanguage } = await import('./resolve-locale')

describe('isSupportedLocale', () => {
  it('should accept every supported locale', () => {
    expect(isSupportedLocale('en')).toBe(true)
    expect(isSupportedLocale('tr')).toBe(true)
  })

  it('should reject an unsupported value', () => {
    expect(isSupportedLocale('fr')).toBe(false)
    expect(isSupportedLocale('')).toBe(false)
  })
})

describe('parseAcceptLanguage', () => {
  it('should pick the first supported tag in preference order', () => {
    expect(parseAcceptLanguage('tr-TR,tr;q=0.9,en;q=0.8')).toBe('tr')
  })

  it('should default to en when no tag is supported', () => {
    expect(parseAcceptLanguage('fr-FR,fr;q=0.9')).toBe('en')
  })

  it('should default to en for a null header', () => {
    expect(parseAcceptLanguage(null)).toBe('en')
  })
})
