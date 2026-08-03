import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GET } from './route'
import { CRM_OAUTH_STATE_COOKIE } from '../state-cookie'

const hoisted = vi.hoisted(() => ({
  requireUser: vi.fn(),
  exchangeCode: vi.fn(),
  upsertCrmConnection: vi.fn(),
}))

vi.mock('@/lib/auth/require-user', () => ({ requireUser: hoisted.requireUser }))
vi.mock('@/lib/crm/registry', () => ({
  getCrmProvider: () => ({ exchangeCode: hoisted.exchangeCode }),
}))
vi.mock('@/lib/db/crm-connections', () => ({ upsertCrmConnection: hoisted.upsertCrmConnection }))
vi.mock('@/lib/crm/tokens', () => ({ encryptCrmTokens: () => ({ v: 1 }) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/events/log-event', () => ({ logEvent: vi.fn() }))

const STATE = 'nonce-abc'

function params(provider = 'hubspot') {
  return { params: Promise.resolve({ provider }) }
}

function request(search: string, cookieState: string | null = STATE): Request {
  const headers = new Headers()
  if (cookieState !== null) headers.set('cookie', `${CRM_OAUTH_STATE_COOKIE}=${cookieState}`)
  return new Request(`https://app.test/api/crm/hubspot/callback${search}`, { headers })
}

function locationOf(response: Response): string {
  return response.headers.get('location') ?? ''
}

beforeEach(() => {
  vi.clearAllMocks()
  hoisted.requireUser.mockResolvedValue({ appUser: { id: 'u1', role: 'client', client_id: 'c1' } })
  hoisted.exchangeCode.mockResolvedValue({
    tokens: { kind: 'oauth', accessToken: 'at', refreshToken: 'rt', expiresAt: '2099-01-01T00:00:00.000Z' },
    accountLabel: 'Acme Portal',
    accountRef: '123',
  })
  hoisted.upsertCrmConnection.mockResolvedValue({ id: 'conn-1' })
})

describe('GET /api/crm/[provider]/callback', () => {
  it('should store the connection and redirect to setup when the exchange succeeds', async () => {
    const response = await GET(request(`?code=the-code&state=${STATE}`), params())

    expect(hoisted.upsertCrmConnection).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ clientId: 'c1', provider: 'hubspot', accountLabel: 'Acme Portal', accountRef: '123' }),
    )
    expect(locationOf(response)).toContain('/settings/crm?connect=hubspot')
  })

  it('should reject the callback when the state does not match the cookie', async () => {
    const response = await GET(request('?code=the-code&state=forged'), params())

    expect(hoisted.upsertCrmConnection).not.toHaveBeenCalled()
    expect(locationOf(response)).toContain('error=oauth')
  })

  it('should reject the callback when no state cookie is present', async () => {
    const response = await GET(request(`?code=the-code&state=${STATE}`, null), params())

    expect(locationOf(response)).toContain('error=oauth')
  })

  it('should reject the callback when the provider returned no code', async () => {
    const response = await GET(request(`?state=${STATE}`), params())

    expect(locationOf(response)).toContain('error=oauth')
  })

  it('should redirect with the error code when the exchange fails', async () => {
    const { AppError } = await import('@/lib/errors/app-error')
    hoisted.exchangeCode.mockRejectedValue(new AppError('EXTERNAL_ERROR', 'boom'))

    const response = await GET(request(`?code=the-code&state=${STATE}`), params())

    expect(locationOf(response)).toContain('error=EXTERNAL_ERROR')
  })

  it('should reject an operator, because a CRM grant belongs to the client', async () => {
    hoisted.requireUser.mockResolvedValue({ appUser: { id: 'u1', role: 'operator', client_id: null } })

    expect((await GET(request(`?code=c&state=${STATE}`), params())).status).toBe(403)
  })

  it('should return 404 for a provider outside the supported set', async () => {
    expect((await GET(request(`?code=c&state=${STATE}`), params('salesforce'))).status).toBe(404)
  })
})
