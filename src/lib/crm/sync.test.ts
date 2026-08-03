import { describe, it, expect, vi, beforeEach } from 'vitest'
import { runCrmSync } from './sync'
import { AppError } from '@/lib/errors/app-error'
import type { CrmProvider } from './provider'
import type { CrmOAuthCredentials } from './tokens'

const hoisted = vi.hoisted(() => ({
  getCrmConnectionForClient: vi.fn(),
  markCrmConnectionError: vi.fn(),
  updateCrmConnectionTokens: vi.fn(),
  getCaseCrmLink: vi.fn(),
  ensureCaseCrmLink: vi.fn(),
  claimCrmSync: vi.fn(),
  updateCaseCrmLinkIds: vi.fn(),
  markCrmSyncResult: vi.fn(),
  getCaseById: vi.fn(),
  listActiveLeadsForCase: vi.fn(),
  getCampaignForCase: vi.fn(),
  getCrmProvider: vi.fn(),
  parseCrmTokens: vi.fn(),
  encryptCrmTokens: vi.fn(),
}))

vi.mock('@/lib/db/crm-connections', () => ({
  getCrmConnectionForClient: hoisted.getCrmConnectionForClient,
  markCrmConnectionError: hoisted.markCrmConnectionError,
  updateCrmConnectionTokens: hoisted.updateCrmConnectionTokens,
}))
vi.mock('@/lib/db/case-crm-links', () => ({
  getCaseCrmLink: hoisted.getCaseCrmLink,
  ensureCaseCrmLink: hoisted.ensureCaseCrmLink,
  claimCrmSync: hoisted.claimCrmSync,
  updateCaseCrmLinkIds: hoisted.updateCaseCrmLinkIds,
  markCrmSyncResult: hoisted.markCrmSyncResult,
}))
vi.mock('@/lib/db/cases', () => ({ getCaseById: hoisted.getCaseById }))
vi.mock('@/lib/db/leads', () => ({ listActiveLeadsForCase: hoisted.listActiveLeadsForCase }))
vi.mock('@/lib/db/campaigns', () => ({ getCampaignForCase: hoisted.getCampaignForCase }))
vi.mock('./registry', () => ({ getCrmProvider: hoisted.getCrmProvider }))
vi.mock('./tokens', () => ({
  parseCrmTokens: hoisted.parseCrmTokens,
  encryptCrmTokens: hoisted.encryptCrmTokens,
}))
vi.mock('@/lib/events/log-event', () => ({ logEventSafe: vi.fn(), logError: vi.fn() }))

const supabase = {} as never
const now = new Date('2026-08-02T12:00:00.000Z')

const credentials: CrmOAuthCredentials = {
  kind: 'oauth', accessToken: 'at', refreshToken: 'rt', expiresAt: '2099-01-01T00:00:00.000Z',
}

function connection(overrides: Record<string, unknown> = {}) {
  return {
    id: 'conn-1',
    client_id: 'c1',
    provider: 'hubspot',
    account_ref: '123',
    oauth: { v: 1 },
    pipeline_id: 'p1',
    initial_stage_id: 's1',
    won_stage_id: 's9',
    lost_stage_id: 's10',
    status: 'connected',
    ...overrides,
  }
}

function link(overrides: Record<string, unknown> = {}) {
  return {
    id: 'link-1',
    case_id: 'case-1',
    external_company_id: null,
    external_contact_ids: [],
    external_deal_id: null,
    external_deal_url: null,
    ...overrides,
  }
}

function fakeProvider(): CrmProvider {
  return {
    provider: 'hubspot',
    buildAuthUrl: vi.fn(),
    exchangeCode: vi.fn(),
    listPipelines: vi.fn(),
    upsertCompany: vi.fn().mockResolvedValue({ externalId: 'co-1', tokens: credentials }),
    upsertContact: vi.fn().mockResolvedValue({ externalId: 'ct-1', tokens: credentials }),
    createDeal: vi.fn().mockResolvedValue({ externalId: 'deal-1', url: 'https://crm/deal/1', tokens: credentials }),
    moveDeal: vi.fn().mockResolvedValue({ tokens: credentials }),
    addDealNote: vi.fn().mockResolvedValue({ tokens: credentials }),
  } as unknown as CrmProvider
}

let provider: CrmProvider

beforeEach(() => {
  vi.clearAllMocks()
  provider = fakeProvider()
  hoisted.getCrmProvider.mockReturnValue(provider)
  hoisted.parseCrmTokens.mockReturnValue(credentials)
  hoisted.encryptCrmTokens.mockReturnValue({ v: 1 })
  hoisted.getCaseById.mockResolvedValue({
    id: 'case-1', client_id: 'c1', company_name: 'Acme', company_domain: 'acme.com', summary: 'Growing fast.',
  })
  hoisted.getCampaignForCase.mockResolvedValue({ id: 'camp-1', name: 'Q3 Outbound' })
  hoisted.listActiveLeadsForCase.mockResolvedValue([
    { email: 'ada@acme.com', full_name: 'Ada Lovelace', title: 'CTO', linkedin_url: null,
      company_name: 'Acme', email_status: 'verified', status: 'active' },
  ])
  hoisted.getCrmConnectionForClient.mockResolvedValue(connection())
  hoisted.ensureCaseCrmLink.mockResolvedValue(link())
  hoisted.claimCrmSync.mockResolvedValue(true)
  hoisted.getCaseCrmLink.mockResolvedValue(link())
})

describe('runCrmSync — preconditions', () => {
  it('should skip when the case does not exist', async () => {
    hoisted.getCaseById.mockResolvedValue(null)

    const outcome = await runCrmSync(supabase, { caseId: 'case-1', reason: 'qualified', now })

    expect(outcome).toEqual({ kind: 'skipped', reason: 'case_not_found' })
  })

  it('should skip when the client has not connected a CRM', async () => {
    hoisted.getCrmConnectionForClient.mockResolvedValue(null)

    const outcome = await runCrmSync(supabase, { caseId: 'case-1', reason: 'qualified', now })

    expect(outcome).toEqual({ kind: 'skipped', reason: 'no_connection' })
  })

  it('should skip when the connection has not finished pipeline selection', async () => {
    hoisted.getCrmConnectionForClient.mockResolvedValue(connection({ pipeline_id: null }))

    const outcome = await runCrmSync(supabase, { caseId: 'case-1', reason: 'qualified', now })

    expect(outcome).toEqual({ kind: 'skipped', reason: 'setup_incomplete' })
  })

  it('should skip when the connection is parked in the error state', async () => {
    hoisted.getCrmConnectionForClient.mockResolvedValue(connection({ status: 'error' }))

    const outcome = await runCrmSync(supabase, { caseId: 'case-1', reason: 'qualified', now })

    expect(outcome).toEqual({ kind: 'skipped', reason: 'connection_errored' })
  })

  it('should report busy without touching the CRM when another worker holds the claim', async () => {
    hoisted.claimCrmSync.mockResolvedValue(false)

    const outcome = await runCrmSync(supabase, { caseId: 'case-1', reason: 'qualified', now })

    expect(outcome).toEqual({ kind: 'busy' })
    expect(provider.createDeal).not.toHaveBeenCalled()
  })
})

describe('runCrmSync — create path', () => {
  it('should create company, contact, and deal then record success', async () => {
    const outcome = await runCrmSync(supabase, { caseId: 'case-1', reason: 'qualified', now })

    expect(outcome).toEqual({ kind: 'synced' })
    expect(provider.upsertCompany).toHaveBeenCalledWith(credentials, { name: 'Acme', domain: 'acme.com' })
    expect(provider.upsertContact).toHaveBeenCalledTimes(1)
    expect(provider.createDeal).toHaveBeenCalledWith(
      credentials,
      expect.objectContaining({
        title: 'Acme — Q3 Outbound',
        pipelineId: 'p1',
        stageId: 's1',
        companyExternalId: 'co-1',
        contactExternalIds: ['ct-1'],
        accountRef: '123',
      }),
    )
    expect(hoisted.markCrmSyncResult).toHaveBeenCalledWith(supabase, 'case-1', { status: 'ok' })
  })

  it('should persist each external id as it is obtained so a retry can resume', async () => {
    await runCrmSync(supabase, { caseId: 'case-1', reason: 'qualified', now })

    expect(hoisted.updateCaseCrmLinkIds).toHaveBeenCalledWith(supabase, 'case-1', { externalCompanyId: 'co-1' })
    expect(hoisted.updateCaseCrmLinkIds).toHaveBeenCalledWith(supabase, 'case-1', { externalContactIds: ['ct-1'] })
    expect(hoisted.updateCaseCrmLinkIds).toHaveBeenCalledWith(supabase, 'case-1', {
      externalDealId: 'deal-1',
      externalDealUrl: 'https://crm/deal/1',
    })
  })

  it('should attach the dossier summary and case link as the creation note', async () => {
    await runCrmSync(supabase, { caseId: 'case-1', reason: 'qualified', now })

    const note = vi.mocked(provider.addDealNote).mock.calls[0]?.[2] ?? ''
    expect(note).toContain('Growing fast.')
    expect(note).toContain('/cases/case-1')
  })

  it('should skip the company step when it was already created by an earlier attempt', async () => {
    hoisted.ensureCaseCrmLink.mockResolvedValue(link({ external_company_id: 'co-existing' }))

    await runCrmSync(supabase, { caseId: 'case-1', reason: 'qualified', now })

    expect(provider.upsertCompany).not.toHaveBeenCalled()
    expect(provider.createDeal).toHaveBeenCalledWith(
      credentials,
      expect.objectContaining({ companyExternalId: 'co-existing' }),
    )
  })

  it('should never create a second deal once one is linked', async () => {
    hoisted.ensureCaseCrmLink.mockResolvedValue(link({ external_deal_id: 'deal-existing' }))

    await runCrmSync(supabase, { caseId: 'case-1', reason: 'contacted', now })

    expect(provider.createDeal).not.toHaveBeenCalled()
    expect(provider.upsertCompany).not.toHaveBeenCalled()
  })

  it('should sync only leads that are verified, active, and have an email', async () => {
    hoisted.listActiveLeadsForCase.mockResolvedValue([
      { email: 'ada@acme.com', full_name: 'Ada', title: null, linkedin_url: null,
        company_name: 'Acme', email_status: 'verified', status: 'active' },
      { email: null, full_name: 'No Email', title: null, linkedin_url: null,
        company_name: 'Acme', email_status: 'verified', status: 'active' },
      { email: 'risky@acme.com', full_name: 'Risky', title: null, linkedin_url: null,
        company_name: 'Acme', email_status: 'risky', status: 'active' },
    ])

    await runCrmSync(supabase, { caseId: 'case-1', reason: 'qualified', now })

    expect(provider.upsertContact).toHaveBeenCalledTimes(1)
  })
})

describe('runCrmSync — reason handling', () => {
  it('should add a note without moving the deal for an intermediate reason', async () => {
    hoisted.ensureCaseCrmLink.mockResolvedValue(link({ external_deal_id: 'deal-1' }))

    await runCrmSync(supabase, { caseId: 'case-1', reason: 'contacted', now })

    expect(provider.moveDeal).not.toHaveBeenCalled()
    expect(provider.addDealNote).toHaveBeenCalledWith(credentials, 'deal-1', expect.stringContaining('First outreach'))
  })

  it('should close the deal as won when the case is won', async () => {
    hoisted.ensureCaseCrmLink.mockResolvedValue(link({ external_deal_id: 'deal-1' }))

    await runCrmSync(supabase, { caseId: 'case-1', reason: 'won', now })

    expect(provider.moveDeal).toHaveBeenCalledWith(credentials, 'deal-1', { kind: 'closed', outcome: 'won' })
  })

  it('should close the deal as lost when the case is lost', async () => {
    hoisted.ensureCaseCrmLink.mockResolvedValue(link({ external_deal_id: 'deal-1' }))

    await runCrmSync(supabase, { caseId: 'case-1', reason: 'lost', now })

    expect(provider.moveDeal).toHaveBeenCalledWith(credentials, 'deal-1', { kind: 'closed', outcome: 'lost' })
  })

  it('should close the deal as lost when the follow-up sequence exhausts', async () => {
    hoisted.ensureCaseCrmLink.mockResolvedValue(link({ external_deal_id: 'deal-1' }))

    await runCrmSync(supabase, { caseId: 'case-1', reason: 'dead', now })

    expect(provider.moveDeal).toHaveBeenCalledWith(credentials, 'deal-1', { kind: 'closed', outcome: 'lost' })
    expect(provider.addDealNote).toHaveBeenCalledWith(credentials, 'deal-1', expect.stringContaining('No reply'))
  })
})

describe('runCrmSync — error handling', () => {
  it('should park the connection and stop retrying when the token was revoked', async () => {
    vi.mocked(provider.upsertCompany).mockRejectedValue(
      new AppError('EXTERNAL_ERROR', 'HTTP 401', { status: 401 }),
    )

    const outcome = await runCrmSync(supabase, { caseId: 'case-1', reason: 'qualified', now })

    expect(outcome.kind).toBe('permanent_failure')
    expect(hoisted.markCrmConnectionError).toHaveBeenCalledWith(supabase, 'conn-1', 'token_revoked')
  })

  it('should rethrow so QStash retries when the CRM rate limits', async () => {
    vi.mocked(provider.upsertCompany).mockRejectedValue(
      new AppError('EXTERNAL_ERROR', 'HTTP 429', { status: 429 }),
    )

    await expect(
      runCrmSync(supabase, { caseId: 'case-1', reason: 'qualified', now }),
    ).rejects.toBeInstanceOf(AppError)
  })

  it('should rethrow so QStash retries when the CRM returns a server error', async () => {
    vi.mocked(provider.upsertCompany).mockRejectedValue(
      new AppError('EXTERNAL_ERROR', 'HTTP 503', { status: 503 }),
    )

    await expect(
      runCrmSync(supabase, { caseId: 'case-1', reason: 'qualified', now }),
    ).rejects.toBeInstanceOf(AppError)
  })

  it('should rethrow so QStash retries when the CRM call times out', async () => {
    vi.mocked(provider.upsertCompany).mockRejectedValue(new AppError('EXTERNAL_TIMEOUT', 'timed out', {}))

    await expect(
      runCrmSync(supabase, { caseId: 'case-1', reason: 'qualified', now }),
    ).rejects.toBeInstanceOf(AppError)
  })

  it('should record a permanent failure and release the claim on a validation error', async () => {
    vi.mocked(provider.upsertCompany).mockRejectedValue(
      new AppError('EXTERNAL_ERROR', 'HTTP 400', { status: 400 }),
    )

    const outcome = await runCrmSync(supabase, { caseId: 'case-1', reason: 'qualified', now })

    expect(outcome.kind).toBe('permanent_failure')
    expect(hoisted.markCrmSyncResult).toHaveBeenCalledWith(
      supabase, 'case-1', expect.objectContaining({ status: 'error' }),
    )
  })

  it('should release the claim even when the failure is retryable', async () => {
    vi.mocked(provider.upsertCompany).mockRejectedValue(
      new AppError('EXTERNAL_ERROR', 'HTTP 503', { status: 503 }),
    )

    await expect(runCrmSync(supabase, { caseId: 'case-1', reason: 'qualified', now })).rejects.toThrow()

    expect(hoisted.markCrmSyncResult).toHaveBeenCalled()
  })
})

describe('runCrmSync — token persistence', () => {
  it('should persist refreshed credentials as soon as a call rotates them', async () => {
    const rotated = { ...credentials, accessToken: 'at-2', refreshToken: 'rt-2' }
    vi.mocked(provider.upsertCompany).mockResolvedValue({ externalId: 'co-1', tokens: rotated })

    await runCrmSync(supabase, { caseId: 'case-1', reason: 'qualified', now })

    expect(hoisted.encryptCrmTokens).toHaveBeenCalledWith(rotated)
    expect(hoisted.updateCrmConnectionTokens).toHaveBeenCalledWith(supabase, 'conn-1', { v: 1 })
  })

  it('should not write credentials back when nothing was refreshed', async () => {
    await runCrmSync(supabase, { caseId: 'case-1', reason: 'qualified', now })

    expect(hoisted.updateCrmConnectionTokens).not.toHaveBeenCalled()
  })
})
