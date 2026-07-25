export interface CompanyFirmographics {
  industry: string | null
  employeeCount: number | null
  foundedYear: number | null
  description: string | null
  city: string | null
  state: string | null
  country: string | null
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
