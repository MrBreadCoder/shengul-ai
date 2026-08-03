import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { hubspotProvider } from './hubspot-provider'
import { AppError } from '@/lib/errors/app-error'
import type { CrmOAuthCredentials } from './tokens'

const credentials: CrmOAuthCredentials = {
  kind: 'oauth',
  accessToken: 'hs-access',
  refreshToken: 'hs-refresh',
  // Far future so no test accidentally triggers the refresh path.
  expiresAt: '2099-01-01T00:00:00.000Z',
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function mockFetch(): ReturnType<typeof vi.fn> {
  return globalThis.fetch as unknown as ReturnType<typeof vi.fn>
}

describe('hubspotProvider.buildAuthUrl', () => {
  it('should target the HubSpot consent screen carrying the state nonce', () => {
    const url = new URL(hubspotProvider.buildAuthUrl('nonce-123'))

    expect(url.origin + url.pathname).toBe('https://app.hubspot.com/oauth/authorize')
    expect(url.searchParams.get('state')).toBe('nonce-123')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('scope')).toContain('crm.objects.deals.write')
  })
})

describe('hubspotProvider.exchangeCode', () => {
  it('should return credentials plus the portal label and hub id', async () => {
    mockFetch()
      .mockResolvedValueOnce(
        jsonResponse({ access_token: 'at', refresh_token: 'rt', expires_in: 1800 }),
      )
      .mockResolvedValueOnce(jsonResponse({ hub_id: 12345678, hub_domain: 'acme.hubspot.com' }))

    const result = await hubspotProvider.exchangeCode('the-code')

    expect(result.tokens.accessToken).toBe('at')
    expect(result.tokens.refreshToken).toBe('rt')
    expect(Date.parse(result.tokens.expiresAt)).toBeGreaterThan(Date.now())
    expect(result.accountLabel).toBe('acme.hubspot.com')
    expect(result.accountRef).toBe('12345678')
  })

  it('should throw EXTERNAL_ERROR when HubSpot rejects the code', async () => {
    mockFetch().mockResolvedValueOnce(jsonResponse({ message: 'invalid code' }, 400))

    await expect(hubspotProvider.exchangeCode('bad')).rejects.toBeInstanceOf(AppError)
  })

  it('should throw EXTERNAL_ERROR when the token response omits a refresh token', async () => {
    mockFetch().mockResolvedValueOnce(jsonResponse({ access_token: 'at', expires_in: 1800 }))

    await expect(hubspotProvider.exchangeCode('the-code')).rejects.toBeInstanceOf(AppError)
  })
})

describe('hubspotProvider.listPipelines', () => {
  it('should map stages and flag the closed-won and closed-lost ones', async () => {
    mockFetch().mockResolvedValueOnce(
      jsonResponse({
        results: [
          {
            id: 'default',
            label: 'Sales Pipeline',
            stages: [
              { id: 's1', label: 'New', metadata: { probability: '0.2' } },
              { id: 's9', label: 'Closed Won', metadata: { probability: '1.0' } },
              { id: 's10', label: 'Closed Lost', metadata: { probability: '0.0' } },
            ],
          },
        ],
      }),
    )

    const { pipelines } = await hubspotProvider.listPipelines(credentials)

    expect(pipelines).toEqual([
      {
        id: 'default',
        label: 'Sales Pipeline',
        stages: [
          { id: 's1', label: 'New', closedOutcome: null },
          { id: 's9', label: 'Closed Won', closedOutcome: 'won' },
          { id: 's10', label: 'Closed Lost', closedOutcome: 'lost' },
        ],
      },
    ])
  })

  it('should throw EXTERNAL_ERROR carrying the status when HubSpot rate limits', async () => {
    mockFetch().mockResolvedValueOnce(jsonResponse({ message: 'rate limited' }, 429))

    await expect(hubspotProvider.listPipelines(credentials)).rejects.toMatchObject({
      code: 'EXTERNAL_ERROR',
      context: { status: 429 },
    })
  })

  it('should throw EXTERNAL_ERROR when the response shape is unexpected', async () => {
    mockFetch().mockResolvedValueOnce(jsonResponse({ nope: true }))

    await expect(hubspotProvider.listPipelines(credentials)).rejects.toBeInstanceOf(AppError)
  })
})

describe('hubspotProvider.upsertCompany', () => {
  it('should patch the existing company when the domain already matches one', async () => {
    mockFetch()
      .mockResolvedValueOnce(jsonResponse({ results: [{ id: 'co-1' }] }))
      .mockResolvedValueOnce(jsonResponse({ id: 'co-1' }))

    const { externalId } = await hubspotProvider.upsertCompany(credentials, {
      name: 'Acme',
      domain: 'acme.com',
    })

    expect(externalId).toBe('co-1')
    expect(mockFetch().mock.calls[1]?.[1]).toMatchObject({ method: 'PATCH' })
  })

  it('should create the company when no domain match exists', async () => {
    mockFetch()
      .mockResolvedValueOnce(jsonResponse({ results: [] }))
      .mockResolvedValueOnce(jsonResponse({ id: 'co-2' }))

    const { externalId } = await hubspotProvider.upsertCompany(credentials, {
      name: 'Acme',
      domain: 'acme.com',
    })

    expect(externalId).toBe('co-2')
    expect(mockFetch().mock.calls[1]?.[1]).toMatchObject({ method: 'POST' })
  })

  it('should create without searching when the case has no domain to match on', async () => {
    mockFetch().mockResolvedValueOnce(jsonResponse({ id: 'co-3' }))

    const { externalId } = await hubspotProvider.upsertCompany(credentials, {
      name: 'Acme',
      domain: null,
    })

    expect(externalId).toBe('co-3')
    expect(mockFetch()).toHaveBeenCalledTimes(1)
  })
})

describe('hubspotProvider.upsertContact', () => {
  const contact = {
    email: 'ada@acme.com',
    firstName: 'Ada',
    lastName: 'Lovelace',
    title: 'CTO',
    linkedinUrl: 'https://linkedin.com/in/ada',
    companyName: 'Acme',
  }

  it('should patch the existing contact when the email already matches one', async () => {
    mockFetch()
      .mockResolvedValueOnce(jsonResponse({ results: [{ id: 'ct-1' }] }))
      .mockResolvedValueOnce(jsonResponse({ id: 'ct-1' }))

    const { externalId } = await hubspotProvider.upsertContact(credentials, contact)

    expect(externalId).toBe('ct-1')
    expect(mockFetch().mock.calls[1]?.[1]).toMatchObject({ method: 'PATCH' })
  })

  it('should create the contact when the email is new to the portal', async () => {
    mockFetch()
      .mockResolvedValueOnce(jsonResponse({ results: [] }))
      .mockResolvedValueOnce(jsonResponse({ id: 'ct-2' }))

    const { externalId } = await hubspotProvider.upsertContact(credentials, contact)

    expect(externalId).toBe('ct-2')
  })

  it('should throw EXTERNAL_ERROR when HubSpot rejects the credentials', async () => {
    mockFetch().mockResolvedValueOnce(jsonResponse({ message: 'expired' }, 401))

    await expect(hubspotProvider.upsertContact(credentials, contact)).rejects.toMatchObject({
      context: { status: 401 },
    })
  })
})

describe('hubspotProvider.createDeal', () => {
  it('should create the deal with company and contact associations and a portal URL', async () => {
    mockFetch().mockResolvedValueOnce(jsonResponse({ id: 'deal-1' }))

    const { externalId, url } = await hubspotProvider.createDeal(credentials, {
      title: 'Acme — Q3',
      pipelineId: 'default',
      stageId: 's1',
      companyExternalId: 'co-1',
      contactExternalIds: ['ct-1', 'ct-2'],
      accountRef: '12345678',
    })

    expect(externalId).toBe('deal-1')
    expect(url).toBe('https://app.hubspot.com/contacts/12345678/record/0-3/deal-1')

    const body = JSON.parse(String(mockFetch().mock.calls[0]?.[1]?.body))
    expect(body.properties).toMatchObject({ dealname: 'Acme — Q3', pipeline: 'default', dealstage: 's1' })
    expect(body.associations).toHaveLength(3)
  })

  it('should omit the company association when the case had no company id', async () => {
    mockFetch().mockResolvedValueOnce(jsonResponse({ id: 'deal-2' }))

    await hubspotProvider.createDeal(credentials, {
      title: 'Acme',
      pipelineId: 'default',
      stageId: 's1',
      companyExternalId: null,
      contactExternalIds: [],
      accountRef: '12345678',
    })

    const body = JSON.parse(String(mockFetch().mock.calls[0]?.[1]?.body))
    expect(body.associations).toEqual([])
  })

  it('should fall back to an empty URL when the connection has no portal id', async () => {
    mockFetch().mockResolvedValueOnce(jsonResponse({ id: 'deal-3' }))

    const { url } = await hubspotProvider.createDeal(credentials, {
      title: 'Acme',
      pipelineId: 'default',
      stageId: 's1',
      companyExternalId: null,
      contactExternalIds: [],
      accountRef: null,
    })

    expect(url).toBe('')
  })
})

describe('hubspotProvider.moveDeal', () => {
  it('should patch the deal stage when given a stage target', async () => {
    mockFetch().mockResolvedValueOnce(jsonResponse({ id: 'deal-1' }))

    await hubspotProvider.moveDeal(credentials, 'deal-1', { kind: 'stage', stageId: 's5' })

    const body = JSON.parse(String(mockFetch().mock.calls[0]?.[1]?.body))
    expect(body.properties.dealstage).toBe('s5')
  })

  it('should resolve the closed-won stage from the pipeline when closing as won', async () => {
    mockFetch()
      .mockResolvedValueOnce(jsonResponse({ properties: { pipeline: 'default' } }))
      .mockResolvedValueOnce(
        jsonResponse({
          results: [
            {
              id: 'default',
              label: 'Sales',
              stages: [
                { id: 's1', label: 'New', metadata: { probability: '0.2' } },
                { id: 's9', label: 'Closed Won', metadata: { probability: '1.0' } },
              ],
            },
          ],
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ id: 'deal-1' }))

    await hubspotProvider.moveDeal(credentials, 'deal-1', { kind: 'closed', outcome: 'won' })

    const body = JSON.parse(String(mockFetch().mock.calls[2]?.[1]?.body))
    expect(body.properties.dealstage).toBe('s9')
  })

  it('should record a note instead of moving when the pipeline has no closed stage', async () => {
    mockFetch()
      .mockResolvedValueOnce(jsonResponse({ properties: { pipeline: 'default' } }))
      .mockResolvedValueOnce(
        jsonResponse({
          results: [
            { id: 'default', label: 'Sales', stages: [{ id: 's1', label: 'New', metadata: { probability: '0.2' } }] },
          ],
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ id: 'note-1' }))

    await hubspotProvider.moveDeal(credentials, 'deal-1', { kind: 'closed', outcome: 'lost' })

    const lastCall = mockFetch().mock.calls[2]?.[0]
    expect(String(lastCall)).toContain('/crm/v3/objects/notes')
  })
})

describe('hubspotProvider.addDealNote', () => {
  it('should create a note associated with the deal', async () => {
    mockFetch().mockResolvedValueOnce(jsonResponse({ id: 'note-1' }))

    await hubspotProvider.addDealNote(credentials, 'deal-1', 'First outreach sent')

    const body = JSON.parse(String(mockFetch().mock.calls[0]?.[1]?.body))
    expect(body.properties.hs_note_body).toBe('First outreach sent')
    expect(body.associations[0].to.id).toBe('deal-1')
  })

  it('should throw EXTERNAL_ERROR when HubSpot returns a server error', async () => {
    mockFetch().mockResolvedValueOnce(jsonResponse({ message: 'boom' }, 503))

    await expect(hubspotProvider.addDealNote(credentials, 'deal-1', 'note')).rejects.toMatchObject({
      context: { status: 503 },
    })
  })
})
