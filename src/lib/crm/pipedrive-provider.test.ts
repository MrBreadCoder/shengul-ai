import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { pipedriveProvider } from './pipedrive-provider'
import { AppError } from '@/lib/errors/app-error'
import type { CrmOAuthCredentials } from './tokens'

// accessToken carries the api_domain suffix the provider parses out; see the
// implementation note on why the domain rides along with the token.
const credentials: CrmOAuthCredentials = {
  kind: 'oauth',
  accessToken: 'pd-access|https://acme.pipedrive.com',
  refreshToken: 'pd-refresh',
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

describe('pipedriveProvider.buildAuthUrl', () => {
  it('should target the Pipedrive consent screen carrying the state nonce', () => {
    const url = new URL(pipedriveProvider.buildAuthUrl('nonce-123'))

    expect(url.origin + url.pathname).toBe('https://oauth.pipedrive.com/oauth/authorize')
    expect(url.searchParams.get('state')).toBe('nonce-123')
    expect(url.searchParams.get('response_type')).toBe('code')
  })
})

describe('pipedriveProvider.exchangeCode', () => {
  it('should return credentials carrying the api domain plus the account label', async () => {
    mockFetch()
      .mockResolvedValueOnce(
        jsonResponse({
          access_token: 'at',
          refresh_token: 'rt',
          expires_in: 3600,
          api_domain: 'https://acme.pipedrive.com',
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ data: { company_name: 'Acme Ltd' } }))

    const result = await pipedriveProvider.exchangeCode('the-code')

    expect(result.tokens.accessToken).toBe('at|https://acme.pipedrive.com')
    expect(result.tokens.refreshToken).toBe('rt')
    expect(result.accountLabel).toBe('Acme Ltd')
    expect(result.accountRef).toBe('https://acme.pipedrive.com')
  })

  it('should authenticate the token request with HTTP Basic credentials', async () => {
    mockFetch()
      .mockResolvedValueOnce(
        jsonResponse({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, api_domain: 'https://a.pipedrive.com' }),
      )
      .mockResolvedValueOnce(jsonResponse({ data: { company_name: 'A' } }))

    await pipedriveProvider.exchangeCode('the-code')

    const headers = mockFetch().mock.calls[0]?.[1]?.headers as Record<string, string>
    expect(headers.Authorization).toMatch(/^Basic /)
  })

  it('should throw EXTERNAL_ERROR when Pipedrive rejects the code', async () => {
    mockFetch().mockResolvedValueOnce(jsonResponse({ error: 'invalid_grant' }, 400))

    await expect(pipedriveProvider.exchangeCode('bad')).rejects.toBeInstanceOf(AppError)
  })
})

describe('pipedriveProvider.listPipelines', () => {
  it('should attach each pipeline its own stages with no closed outcome flagged', async () => {
    mockFetch()
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: 1, name: 'Sales' }] }))
      .mockResolvedValueOnce(
        jsonResponse({ data: [{ id: 10, name: 'Lead In', pipeline_id: 1 }, { id: 11, name: 'Demo', pipeline_id: 1 }] }),
      )

    const { pipelines } = await pipedriveProvider.listPipelines(credentials)

    expect(pipelines).toEqual([
      {
        id: '1',
        label: 'Sales',
        stages: [
          { id: '10', label: 'Lead In', closedOutcome: null },
          { id: '11', label: 'Demo', closedOutcome: null },
        ],
      },
    ])
  })

  it('should return an empty list when the account has no pipelines', async () => {
    mockFetch()
      .mockResolvedValueOnce(jsonResponse({ data: null }))
      .mockResolvedValueOnce(jsonResponse({ data: null }))

    const { pipelines } = await pipedriveProvider.listPipelines(credentials)

    expect(pipelines).toEqual([])
  })

  it('should throw EXTERNAL_ERROR carrying the status when Pipedrive rate limits', async () => {
    mockFetch().mockResolvedValueOnce(jsonResponse({ error: 'rate limited' }, 429))

    await expect(pipedriveProvider.listPipelines(credentials)).rejects.toMatchObject({
      context: { status: 429 },
    })
  })
})

describe('pipedriveProvider.upsertCompany', () => {
  it('should reuse the existing organization when the name already matches one', async () => {
    mockFetch().mockResolvedValueOnce(jsonResponse({ data: { items: [{ item: { id: 7 } }] } }))

    const { externalId } = await pipedriveProvider.upsertCompany(credentials, {
      name: 'Acme',
      domain: 'acme.com',
    })

    expect(externalId).toBe('7')
    expect(mockFetch()).toHaveBeenCalledTimes(1)
  })

  it('should create the organization when the search finds nothing', async () => {
    mockFetch()
      .mockResolvedValueOnce(jsonResponse({ data: { items: [] } }))
      .mockResolvedValueOnce(jsonResponse({ data: { id: 8 } }))

    const { externalId } = await pipedriveProvider.upsertCompany(credentials, {
      name: 'Acme',
      domain: null,
    })

    expect(externalId).toBe('8')
  })
})

describe('pipedriveProvider.upsertContact', () => {
  const contact = {
    email: 'ada@acme.com',
    firstName: 'Ada',
    lastName: 'Lovelace',
    title: 'CTO',
    linkedinUrl: 'https://linkedin.com/in/ada',
    companyName: 'Acme',
  }

  it('should reuse the existing person when the email already matches one', async () => {
    mockFetch().mockResolvedValueOnce(jsonResponse({ data: { items: [{ item: { id: 3 } }] } }))

    const { externalId } = await pipedriveProvider.upsertContact(credentials, contact)

    expect(externalId).toBe('3')
  })

  it('should create the person with the email marked primary when none matches', async () => {
    mockFetch()
      .mockResolvedValueOnce(jsonResponse({ data: { items: [] } }))
      .mockResolvedValueOnce(jsonResponse({ data: { id: 4 } }))

    const { externalId } = await pipedriveProvider.upsertContact(credentials, contact)

    expect(externalId).toBe('4')
    const body = JSON.parse(String(mockFetch().mock.calls[1]?.[1]?.body))
    expect(body.name).toBe('Ada Lovelace')
    expect(body.email).toEqual([{ value: 'ada@acme.com', primary: true }])
  })

  it('should throw EXTERNAL_ERROR when Pipedrive rejects the credentials', async () => {
    mockFetch().mockResolvedValueOnce(jsonResponse({ error: 'unauthorized' }, 401))

    await expect(pipedriveProvider.upsertContact(credentials, contact)).rejects.toMatchObject({
      context: { status: 401 },
    })
  })
})

describe('pipedriveProvider.createDeal', () => {
  it('should create the deal linked to the organization and first person', async () => {
    mockFetch().mockResolvedValueOnce(jsonResponse({ data: { id: 55 } }))

    const { externalId, url } = await pipedriveProvider.createDeal(credentials, {
      title: 'Acme — Q3',
      pipelineId: '1',
      stageId: '10',
      companyExternalId: '7',
      contactExternalIds: ['3', '4'],
      accountRef: 'https://acme.pipedrive.com',
    })

    expect(externalId).toBe('55')
    expect(url).toBe('https://acme.pipedrive.com/deal/55')

    const body = JSON.parse(String(mockFetch().mock.calls[0]?.[1]?.body))
    expect(body).toMatchObject({ title: 'Acme — Q3', org_id: 7, person_id: 3, pipeline_id: 1, stage_id: 10 })
  })

  it('should omit the person link when the case has no synced contacts', async () => {
    mockFetch().mockResolvedValueOnce(jsonResponse({ data: { id: 56 } }))

    await pipedriveProvider.createDeal(credentials, {
      title: 'Acme',
      pipelineId: '1',
      stageId: '10',
      companyExternalId: null,
      contactExternalIds: [],
      accountRef: 'https://acme.pipedrive.com',
    })

    const body = JSON.parse(String(mockFetch().mock.calls[0]?.[1]?.body))
    expect(body.person_id).toBeUndefined()
    expect(body.org_id).toBeUndefined()
  })
})

describe('pipedriveProvider.moveDeal', () => {
  it('should set the stage when given a stage target', async () => {
    mockFetch().mockResolvedValueOnce(jsonResponse({ data: { id: 55 } }))

    await pipedriveProvider.moveDeal(credentials, '55', { kind: 'stage', stageId: '11' })

    const body = JSON.parse(String(mockFetch().mock.calls[0]?.[1]?.body))
    expect(body).toEqual({ stage_id: 11 })
  })

  it('should set the deal status rather than a stage when closing as won', async () => {
    mockFetch().mockResolvedValueOnce(jsonResponse({ data: { id: 55 } }))

    await pipedriveProvider.moveDeal(credentials, '55', { kind: 'closed', outcome: 'won' })

    const body = JSON.parse(String(mockFetch().mock.calls[0]?.[1]?.body))
    expect(body).toEqual({ status: 'won' })
  })

  it('should set the deal status to lost when closing as lost', async () => {
    mockFetch().mockResolvedValueOnce(jsonResponse({ data: { id: 55 } }))

    await pipedriveProvider.moveDeal(credentials, '55', { kind: 'closed', outcome: 'lost' })

    const body = JSON.parse(String(mockFetch().mock.calls[0]?.[1]?.body))
    expect(body).toEqual({ status: 'lost' })
  })
})

describe('pipedriveProvider.addDealNote', () => {
  it('should create a note attached to the deal', async () => {
    mockFetch().mockResolvedValueOnce(jsonResponse({ data: { id: 90 } }))

    await pipedriveProvider.addDealNote(credentials, '55', 'First outreach sent')

    const body = JSON.parse(String(mockFetch().mock.calls[0]?.[1]?.body))
    expect(body).toEqual({ content: 'First outreach sent', deal_id: 55 })
  })

  it('should throw EXTERNAL_ERROR when Pipedrive returns a server error', async () => {
    mockFetch().mockResolvedValueOnce(jsonResponse({ error: 'boom' }, 503))

    await expect(pipedriveProvider.addDealNote(credentials, '55', 'note')).rejects.toMatchObject({
      context: { status: 503 },
    })
  })
})
