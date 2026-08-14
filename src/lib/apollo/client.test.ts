import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockFetchJson = vi.hoisted(() => vi.fn())
vi.mock('@/lib/http/fetch-json', () => ({ fetchJson: mockFetchJson }))
vi.mock('@/lib/env', () => ({ env: { APOLLO_API_KEY: 'test-apollo-key' } }))

import { searchPeople, bulkMatchPeople } from './client'

describe('searchPeople', () => {
  beforeEach(() => mockFetchJson.mockReset())

  it('should call the mixed_people/api_search endpoint with the API key header', async () => {
    mockFetchJson.mockResolvedValueOnce({ total_entries: 0, people: [] })
    await searchPeople({ page: '1', per_page: '25' })
    // fetchJson was called exactly once by the awaited searchPeople call above
    const [url, options] = mockFetchJson.mock.calls[0]!
    expect(url).toContain('https://api.apollo.io/api/v1/mixed_people/api_search')
    expect(url).toContain('page=1')
    expect(url).toContain('per_page=25')
    expect(options.method).toBe('POST')
    expect(options.headers['x-api-key']).toBe('test-apollo-key')
  })

  it('should serialize array params as repeated query keys', async () => {
    mockFetchJson.mockResolvedValueOnce({ total_entries: 0, people: [] })
    await searchPeople({ 'person_titles[]': ['vp sales', 'founder'] })
    // fetchJson was called exactly once by the awaited searchPeople call above
    const [url] = mockFetchJson.mock.calls[0]!
    const parsed = new URL(url as string)
    expect(parsed.searchParams.getAll('person_titles[]')).toEqual(['vp sales', 'founder'])
  })

  it('should map candidates and resolve the organization domain from primary_domain', async () => {
    mockFetchJson.mockResolvedValueOnce({
      total_entries: 1,
      people: [{
        id: 'p1', first_name: 'Jo', last_name_obfuscated: 'Do***e', title: 'VP Sales',
        linkedin_url: 'https://linkedin.com/in/jo', organization: { name: 'Acme', primary_domain: 'acme.com' },
      }],
    })
    const { totalEntries, candidates } = await searchPeople({})
    expect(totalEntries).toBe(1)
    expect(candidates).toEqual([{
      apolloId: 'p1', firstName: 'Jo', lastNamePreview: 'Do***e', title: 'VP Sales',
      organizationName: 'Acme', organizationDomain: 'acme.com', linkedinUrl: 'https://linkedin.com/in/jo',
      twitterUrl: null,
    }])
  })

  it('should derive the organization domain from website_url when primary_domain is missing', async () => {
    mockFetchJson.mockResolvedValueOnce({
      total_entries: 1,
      people: [{ id: 'p2', first_name: 'Al', organization: { name: 'Beta', website_url: 'https://www.beta.io/home' } }],
    })
    const { candidates } = await searchPeople({})
    // the mocked response above contains exactly one person
    expect(candidates[0]!.organizationDomain).toBe('beta.io')
  })

  it('should return an empty candidate list when the response has no people', async () => {
    mockFetchJson.mockResolvedValueOnce({ total_entries: 0 })
    const { candidates } = await searchPeople({})
    expect(candidates).toEqual([])
  })

  it('should map twitter_url onto the search candidate', async () => {
    mockFetchJson.mockResolvedValueOnce({
      total_entries: 1,
      people: [{ id: 'p8', first_name: 'Al', twitter_url: 'https://x.com/al', organization: { name: 'Beta' } }],
    })
    const { candidates } = await searchPeople({})
    // the mocked response above contains exactly one person
    expect(candidates[0]!.twitterUrl).toBe('https://x.com/al')
  })
})

describe('bulkMatchPeople', () => {
  beforeEach(() => mockFetchJson.mockReset())

  it('should return an empty array without calling fetchJson when details is empty', async () => {
    const result = await bulkMatchPeople([])
    expect(result).toEqual([])
    expect(mockFetchJson).not.toHaveBeenCalled()
  })

  it('should throw VALIDATION_ERROR when more than 10 details are given', async () => {
    const details = Array.from({ length: 11 }, (_, i) => ({ id: `p${i}` }))
    await expect(bulkMatchPeople(details)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
  })

  it('should call bulk_match with reveal_personal_emails=false and the details body', async () => {
    mockFetchJson.mockResolvedValueOnce({ matches: [] })
    await bulkMatchPeople([{ id: 'p1', firstName: 'Jo', domain: 'acme.com' }])
    // fetchJson was called exactly once by the awaited bulkMatchPeople call above
    const [url, options] = mockFetchJson.mock.calls[0]!
    expect(url).toContain('/people/bulk_match')
    expect(url).toContain('reveal_personal_emails=false')
    const body = JSON.parse(options.body as string)
    expect(body.details).toEqual([{
      id: 'p1', first_name: 'Jo', last_name: undefined, organization_name: undefined,
      domain: 'acme.com', linkedin_url: undefined,
    }])
  })

  it('should read email + email_status from the "matches" wrapper key', async () => {
    mockFetchJson.mockResolvedValueOnce({
      matches: [{ id: 'p1', first_name: 'Jo', last_name: 'Doe', email: 'jo@acme.com', email_status: 'Verified', organization: { primary_domain: 'acme.com', name: 'Acme' } }],
    })
    const result = await bulkMatchPeople([{ id: 'p1' }])
    expect(result).toEqual([{
      apolloId: 'p1', firstName: 'Jo', lastName: 'Doe', title: null, email: 'jo@acme.com',
      emailStatus: 'Verified', linkedinUrl: null, twitterUrl: null, organizationName: 'Acme', organizationDomain: 'acme.com',
      organizationIndustry: null, organizationEmployeeCount: null, organizationFoundedYear: null,
      organizationDescription: null, organizationCity: null, organizationState: null, organizationCountry: null,
      organizationLinkedinUrl: null, organizationTwitterUrl: null, organizationRevenue: null,
      organizationHeadcountGrowth6Month: null, organizationHeadcountGrowth12Month: null, organizationHeadcountGrowth24Month: null,
    }])
  })

  it('should map twitter_url and organization social/growth fields from the enriched response', async () => {
    mockFetchJson.mockResolvedValueOnce({
      matches: [{
        id: 'p6',
        twitter_url: 'https://x.com/janedoe',
        organization: {
          name: 'Acme', primary_domain: 'acme.com',
          linkedin_url: 'https://linkedin.com/company/acme',
          twitter_url: 'https://x.com/acme',
          organization_revenue: 1_200_000,
          organization_headcount_six_month_growth: 0.05,
          organization_headcount_twelve_month_growth: 0.12,
          organization_headcount_twenty_four_month_growth: 0.30,
        },
      }],
    })
    const result = await bulkMatchPeople([{ id: 'p6' }])
    // the mocked response above contains exactly one person
    expect(result[0]).toMatchObject({
      twitterUrl: 'https://x.com/janedoe',
      organizationLinkedinUrl: 'https://linkedin.com/company/acme',
      organizationTwitterUrl: 'https://x.com/acme',
      organizationRevenue: 1_200_000,
      organizationHeadcountGrowth6Month: 0.05,
      organizationHeadcountGrowth12Month: 0.12,
      organizationHeadcountGrowth24Month: 0.30,
    })
  })

  it('should return null for twitter_url and organization social/growth fields when absent', async () => {
    mockFetchJson.mockResolvedValueOnce({ matches: [{ id: 'p7' }] })
    const result = await bulkMatchPeople([{ id: 'p7' }])
    // the mocked response above contains exactly one person
    expect(result[0]).toMatchObject({
      twitterUrl: null,
      organizationLinkedinUrl: null,
      organizationTwitterUrl: null,
      organizationRevenue: null,
      organizationHeadcountGrowth6Month: null,
      organizationHeadcountGrowth12Month: null,
      organizationHeadcountGrowth24Month: null,
    })
  })

  it('should map organization firmographics from the enriched response', async () => {
    mockFetchJson.mockResolvedValueOnce({
      matches: [{
        id: 'p4',
        organization: {
          name: 'Acme', primary_domain: 'acme.com',
          industry: 'Software', estimated_num_employees: 120, founded_year: 2016,
          short_description: 'Acme builds workflow automation.',
          city: 'Austin', state: 'TX', country: 'United States',
        },
      }],
    })
    const result = await bulkMatchPeople([{ id: 'p4' }])
    // the mocked response above contains exactly one person
    expect(result[0]).toMatchObject({
      organizationIndustry: 'Software',
      organizationEmployeeCount: 120,
      organizationFoundedYear: 2016,
      organizationDescription: 'Acme builds workflow automation.',
      organizationCity: 'Austin',
      organizationState: 'TX',
      organizationCountry: 'United States',
    })
  })

  it('should return null firmographic fields when organization is absent', async () => {
    mockFetchJson.mockResolvedValueOnce({ matches: [{ id: 'p5' }] })
    const result = await bulkMatchPeople([{ id: 'p5' }])
    // the mocked response above contains exactly one person
    expect(result[0]).toMatchObject({
      organizationIndustry: null,
      organizationEmployeeCount: null,
      organizationFoundedYear: null,
      organizationDescription: null,
      organizationCity: null,
      organizationState: null,
      organizationCountry: null,
    })
  })

  it('should fall back to the "people" wrapper key and contact_emails[0] when top-level email fields are absent', async () => {
    mockFetchJson.mockResolvedValueOnce({
      people: [{ id: 'p2', contact_emails: [{ email: 'al@beta.io', email_status: 'unverified' }] }],
    })
    const result = await bulkMatchPeople([{ id: 'p2' }])
    // the mocked response above contains exactly one person
    expect(result[0]!.email).toBe('al@beta.io')
    expect(result[0]!.emailStatus).toBe('unverified')
  })

  it('should not pair a top-level email_status with a contact-only email of a different status', async () => {
    mockFetchJson.mockResolvedValueOnce({
      matches: [{
        id: 'p3',
        email: null,
        email_status: 'Verified',
        contact_emails: [{ email: 'sam@beta.io', email_status: 'unverified' }],
      }],
    })
    const result = await bulkMatchPeople([{ id: 'p3' }])
    // email and status must come from the same source (contact_emails here) —
    // pairing the top-level status with the contact email would report a
    // stale/incorrect verification state.
    expect(result[0]!.email).toBe('sam@beta.io')
    expect(result[0]!.emailStatus).toBe('unverified')
  })
})
