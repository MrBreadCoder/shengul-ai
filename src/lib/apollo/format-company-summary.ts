import { z } from 'zod'
import type { Json } from '@/types/database'

export interface CompanyFirmographics {
  industry: string | null
  employeeCount: number | null
  foundedYear: number | null
  description: string | null
  city: string | null
  state: string | null
  country: string | null
}

// discover.ts spreads the already-mapped ApolloEnrichedPerson (camelCase)
// onto `leads.raw`, not raw Apollo API JSON — despite the column's name — so
// this schema mirrors ApolloEnrichedPerson's field names, not Apollo's
// snake_case wire format.
const rawOrgFieldsSchema = z.object({
  organizationIndustry: z.string().nullable().optional(),
  organizationEmployeeCount: z.number().nullable().optional(),
  organizationFoundedYear: z.number().nullable().optional(),
  organizationDescription: z.string().nullable().optional(),
  organizationCity: z.string().nullable().optional(),
  organizationState: z.string().nullable().optional(),
  organizationCountry: z.string().nullable().optional(),
}).passthrough()

// Returns null (not a throw) for a lead inserted before this feature shipped,
// or any other shape `raw` doesn't carry firmographics in — missing data is
// not an error condition here.
export function parseCompanyFirmographicsFromRaw(raw: Json): CompanyFirmographics | null {
  const parsed = rawOrgFieldsSchema.safeParse(raw)
  if (!parsed.success) return null
  return {
    industry: parsed.data.organizationIndustry ?? null,
    employeeCount: parsed.data.organizationEmployeeCount ?? null,
    foundedYear: parsed.data.organizationFoundedYear ?? null,
    description: parsed.data.organizationDescription ?? null,
    city: parsed.data.organizationCity ?? null,
    state: parsed.data.organizationState ?? null,
    country: parsed.data.organizationCountry ?? null,
  }
}

function ensureSentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`
}

function buildFirmographicClause(firmographics: CompanyFirmographics): string | null {
  const clauses: string[] = []
  if (firmographics.industry) clauses.push(`${firmographics.industry} industry`)
  if (firmographics.employeeCount !== null) clauses.push(`~${firmographics.employeeCount} employees`)
  if (firmographics.foundedYear !== null) clauses.push(`founded ${firmographics.foundedYear}`)
  if (clauses.length === 0) return null
  return ensureSentence(clauses.join(', '))
}

function buildLocationClause(firmographics: CompanyFirmographics): string | null {
  const parts = [firmographics.city, firmographics.state, firmographics.country]
    .filter((part): part is string => part !== null && part.length > 0)
  if (parts.length === 0) return null
  return `Based in ${parts.join(', ')}.`
}

/**
 * One plain-text sentence summarizing a company's Apollo firmographics, or
 * `null` if every field is null — a case with no captured data gets no row.
 * The company name is prefixed only once, onto the first non-empty section,
 * whichever section that turns out to be.
 */
export function formatCompanySummary(
  companyName: string,
  firmographics: CompanyFirmographics,
): string | null {
  const sections = [
    buildFirmographicClause(firmographics),
    firmographics.description ? ensureSentence(firmographics.description.trim()) : null,
    buildLocationClause(firmographics),
  ].filter((section): section is string => section !== null && section.length > 0)

  if (sections.length === 0) return null

  const [first, ...rest] = sections
  return [`${companyName} — ${first}`, ...rest].join(' ')
}
