import { z } from 'zod'

// Maps directly to Apollo's documented People Search filters
// (POST /mixed_people/api_search). Apollo's public API has no separate
// "industries" filter, so any industry terms an operator wants to target
// go into `keywords` (sent as the free-text `q_keywords` param).
// Apollo's documented enum values for person_seniorities[]
export const apolloPersonSeniorities = [
  'owner', 'founder', 'c_suite', 'partner', 'vp', 'head', 'director', 'manager', 'senior', 'entry', 'intern',
] as const

// Apollo's documented enum values for contact_email_status[]
export const apolloContactEmailStatuses = [
  'verified', 'unverified', 'likely to engage', 'unavailable',
] as const

export const apolloIcpSchema = z.object({
  personTitles: z.array(z.string()).default([]),
  organizationLocations: z.array(z.string()).default([]),
  employeeRangeMin: z.number().int().nonnegative().nullable().default(null),
  employeeRangeMax: z.number().int().nonnegative().nullable().default(null),
  keywords: z.array(z.string()).default([]),
  personSeniorities: z.array(z.enum(apolloPersonSeniorities)).default([]),
  contactEmailStatuses: z.array(z.enum(apolloContactEmailStatuses)).default([]),
  // organization_not_locations[] — confirmed Apollo exclude filter, see
  // "Apollo API research" in docs/superpowers/plans/2026-07-21-apollo-exclude-filters.md.
  excludeOrganizationLocations: z.array(z.string()).default([]),
  // No confirmed Apollo API parameter for keyword exclusion exists — this is
  // applied client-side in src/lib/apollo/exclude-keywords.ts, not sent to Apollo.
  excludeKeywords: z.array(z.string()).default([]),
}).refine(
  (data) => data.employeeRangeMin === null || data.employeeRangeMax === null || data.employeeRangeMin <= data.employeeRangeMax,
  { message: 'employeeRangeMin must be less than or equal to employeeRangeMax', path: ['employeeRangeMin'] },
)

export type ApolloIcpFilters = z.infer<typeof apolloIcpSchema>

export interface ApolloSearchCandidate {
  apolloId: string
  firstName: string
  lastNamePreview: string | null
  title: string | null
  organizationName: string | null
  organizationDomain: string | null
  linkedinUrl: string | null
}

export interface ApolloEnrichedPerson {
  apolloId: string
  firstName: string | null
  lastName: string | null
  title: string | null
  email: string | null
  emailStatus: string | null
  linkedinUrl: string | null
  organizationName: string | null
  organizationDomain: string | null
  organizationIndustry: string | null
  organizationEmployeeCount: number | null
  organizationFoundedYear: number | null
  organizationDescription: string | null
  organizationCity: string | null
  organizationState: string | null
  organizationCountry: string | null
}
