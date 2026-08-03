import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GET } from './route'
import { CRM_OAUTH_STATE_COOKIE } from '../state-cookie'

const hoisted = vi.hoisted(() => ({ requireUser: vi.fn() }))

vi.mock('@/lib/auth/require-user', () => ({ requireUser: hoisted.requireUser }))
vi.mock('@/lib/crm/registry', () => ({
  getCrmProvider: () => ({ buildAuthUrl: (state: string) => `https://crm.test/auth?state=${state}` }),
}))

function params(provider: string) {
  return { params: Promise.resolve({ provider }) }
}

beforeEach(() => {
  vi.clearAllMocks()
  hoisted.requireUser.mockResolvedValue({ appUser: { id: 'u1', role: 'client', client_id: 'c1' } })
})

describe('GET /api/crm/[provider]/connect', () => {
  it('should redirect to the provider consent screen and set the state cookie', async () => {
    const response = await GET(new Request('https://app.test/api/crm/hubspot/connect'), params('hubspot'))

    expect(response.status).toBe(307)
    const location = response.headers.get('location') ?? ''
    expect(location).toContain('https://crm.test/auth?state=')

    const cookie = response.headers.get('set-cookie') ?? ''
    expect(cookie).toContain(CRM_OAUTH_STATE_COOKIE)
    expect(cookie).toContain('HttpOnly')
    // The nonce in the cookie must be the same one sent to the provider.
    const state = new URL(location).searchParams.get('state') ?? ''
    expect(state.length).toBeGreaterThan(0)
    expect(cookie).toContain(state)
  })

  it('should reject an operator, because a CRM grant belongs to the client', async () => {
    hoisted.requireUser.mockResolvedValue({ appUser: { id: 'u1', role: 'operator', client_id: null } })

    expect((await GET(new Request('https://app.test/x'), params('hubspot'))).status).toBe(403)
  })

  it('should return 404 for a provider outside the supported set', async () => {
    expect((await GET(new Request('https://app.test/x'), params('salesforce'))).status).toBe(404)
  })
})
