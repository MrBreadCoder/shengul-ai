import { z } from 'zod'
import { env } from '@/lib/env'
import { fetchJson } from '@/lib/http/fetch-json'
import { AppError } from '@/lib/errors/app-error'
import type { ApolloEnrichedPerson, ApolloSearchCandidate } from './types'

const BASE_URL = 'https://api.apollo.io/api/v1'
const MAX_BULK_MATCH_DETAILS = 10

function authHeaders(): Record<string, string> {
  return { 'Content-Type': 'application/json', 'x-api-key': env.APOLLO_API_KEY }
}

function toURLSearchParams(params: Record<string, string | string[]>): URLSearchParams {
  const usp = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      for (const v of value) usp.append(key, v)
    } else {
      usp.append(key, value)
    }
  }
  return usp
}

const organizationSchema = z.object({
  name: z.string().nullable().optional(),
  primary_domain: z.string().nullable().optional(),
  website_url: z.string().nullable().optional(),
  industry: z.string().nullable().optional(),
  estimated_num_employees: z.number().nullable().optional(),
  founded_year: z.number().nullable().optional(),
  short_description: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  state: z.string().nullable().optional(),
  country: z.string().nullable().optional(),
  linkedin_url: z.string().nullable().optional(),
  twitter_url: z.string().nullable().optional(),
  organization_revenue: z.number().nullable().optional(),
  organization_headcount_six_month_growth: z.number().nullable().optional(),
  organization_headcount_twelve_month_growth: z.number().nullable().optional(),
  organization_headcount_twenty_four_month_growth: z.number().nullable().optional(),
}).nullable().optional()

function domainFromOrg(org: z.infer<typeof organizationSchema>): string | null {
  if (!org) return null
  if (org.primary_domain) return org.primary_domain
  if (org.website_url) {
    try {
      return new URL(org.website_url).hostname.replace(/^www\./, '');
    } catch {
      return null
    }
  }
  return null
}

const searchPersonSchema = z.object({
  id: z.string(),
  first_name: z.string().nullable().optional(),
  last_name: z.string().nullable().optional(),
  last_name_obfuscated: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  linkedin_url: z.string().nullable().optional(),
  twitter_url: z.string().nullable().optional(),
  organization: organizationSchema,
}).passthrough()

const searchResponseSchema = z.object({
  total_entries: z.number().optional(),
  people: z.array(searchPersonSchema).optional(),
}).passthrough()

export async function searchPeople(
  params: Record<string, string | string[]>,
): Promise<{ totalEntries: number; candidates: ApolloSearchCandidate[] }> {
  const query = toURLSearchParams(params)
  const res = await fetchJson(
    `${BASE_URL}/mixed_people/api_search?${query.toString()}`,
    { method: 'POST', headers: authHeaders() },
    searchResponseSchema,
  )
  const candidates: ApolloSearchCandidate[] = (res.people ?? []).map((p) => ({
    apolloId: p.id,
    firstName: p.first_name ?? '',
    lastNamePreview: p.last_name ?? p.last_name_obfuscated ?? null,
    title: p.title ?? null,
    organizationName: p.organization?.name ?? null,
    organizationDomain: domainFromOrg(p.organization),
    linkedinUrl: p.linkedin_url ?? null,
    twitterUrl: p.twitter_url ?? null,
  }))
  return { totalEntries: res.total_entries ?? candidates.length, candidates }
}

const enrichedPersonSchema = z.object({
  id: z.string(),
  first_name: z.string().nullable().optional(),
  last_name: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  linkedin_url: z.string().nullable().optional(),
  twitter_url: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  email_status: z.string().nullable().optional(),
  contact_emails: z.array(z.object({
    email: z.string().nullable().optional(),
    email_status: z.string().nullable().optional(),
  })).optional(),
  organization: organizationSchema,
}).passthrough()

// Apollo's docs use "matches" on some pages and "people" on others for the
// same bulk_match response — accept either rather than guess.
const bulkMatchResponseSchema = z.object({
  matches: z.array(enrichedPersonSchema).optional(),
  people: z.array(enrichedPersonSchema).optional(),
}).passthrough()

export interface BulkMatchDetail {
  id?: string
  firstName?: string
  lastName?: string
  organizationName?: string
  domain?: string
  linkedinUrl?: string
}

export async function bulkMatchPeople(details: BulkMatchDetail[]): Promise<ApolloEnrichedPerson[]> {
  if (details.length === 0) return []
  if (details.length > MAX_BULK_MATCH_DETAILS) {
    throw new AppError('VALIDATION_ERROR', 'Apollo bulk_match accepts at most 10 people per call', {
      count: details.length,
    })
  }
  const body = {
    details: details.map((d) => ({
      id: d.id,
      first_name: d.firstName,
      last_name: d.lastName,
      organization_name: d.organizationName,
      domain: d.domain,
      linkedin_url: d.linkedinUrl,
    })),
  }
  const res = await fetchJson(
    `${BASE_URL}/people/bulk_match?reveal_personal_emails=false`,
    { method: 'POST', headers: authHeaders(), body: JSON.stringify(body) },
    bulkMatchResponseSchema,
  )
  const people = res.matches ?? res.people ?? []
  return people.map((p) => {
    // Keep email + status paired from the same source — never mix the
    // top-level email with a contact_emails status (or vice versa).
    const { email, emailStatus } = p.email
      ? { email: p.email, emailStatus: p.email_status ?? null }
      : { email: p.contact_emails?.[0]?.email ?? null, emailStatus: p.contact_emails?.[0]?.email_status ?? null }
    return {
      apolloId: p.id,
      firstName: p.first_name ?? null,
      lastName: p.last_name ?? null,
      title: p.title ?? null,
      email,
      emailStatus,
      linkedinUrl: p.linkedin_url ?? null,
      twitterUrl: p.twitter_url ?? null,
      organizationName: p.organization?.name ?? null,
      organizationDomain: domainFromOrg(p.organization),
      organizationIndustry: p.organization?.industry ?? null,
      organizationEmployeeCount: p.organization?.estimated_num_employees ?? null,
      organizationFoundedYear: p.organization?.founded_year ?? null,
      organizationDescription: p.organization?.short_description ?? null,
      organizationCity: p.organization?.city ?? null,
      organizationState: p.organization?.state ?? null,
      organizationCountry: p.organization?.country ?? null,
      organizationLinkedinUrl: p.organization?.linkedin_url ?? null,
      organizationTwitterUrl: p.organization?.twitter_url ?? null,
      organizationRevenue: p.organization?.organization_revenue ?? null,
      organizationHeadcountGrowth6Month: p.organization?.organization_headcount_six_month_growth ?? null,
      organizationHeadcountGrowth12Month: p.organization?.organization_headcount_twelve_month_growth ?? null,
      organizationHeadcountGrowth24Month: p.organization?.organization_headcount_twenty_four_month_growth ?? null,
    }
  })
}
