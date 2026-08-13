// Apollo withholds the real identity of orgs it treats as confidential
// (private aviation, family offices, defense/government, some PE portfolio
// companies): instead of a real name it substitutes a templated placeholder
// like "Private Airline Based in UAE" or "Confidential Company Based in
// Riyadh", and organization_domain/city/state/country/founded_year all come
// back null alongside it. See leads.company_name = "Private Airline Based in
// UAE" (docs investigation, 2026-08-13) — organizationDomain, city, state,
// and country were all null on that row; only industry and employee count
// survived.
//
// Two independent signals catch this, applied at two different pipeline
// stages because they depend on data available at different points:
//   1. isRedactedOrgName matches the templated name text — the only company
//      signal a pre-enrich Apollo search candidate carries, so this can run
//      before Apollo's enrich call (bulk_match) and before any credit spend.
//   2. hasTooManyBlankCompanyFields inspects the firmographic fields
//      (domain/city/state/country/founded year) that only exist after
//      enrich — it is a backstop for the same redaction pattern slipping
//      through under a name that doesn't match the template, plus a general
//      guard against companies Apollo simply has very little data on.

const REDACTED_ORG_NAME_PATTERN = /^(private|confidential|government)\b.*\bbased in\b/i

/**
 * True when an organization name is Apollo's placeholder for a
 * confidential/undisclosed company rather than a real company name.
 */
export function isRedactedOrgName(organizationName: string | null): boolean {
  if (!organizationName) return false
  return REDACTED_ORG_NAME_PATTERN.test(organizationName.trim())
}

export interface CompanyFieldPresence {
  companyDomain: string | null
  city: string | null
  state: string | null
  country: string | null
  foundedYear: number | null
}

// Rejecting at 2+ blanks (out of 5) is a deliberate operator threshold: a
// real company is occasionally missing one of these in Apollo's data, but
// missing two or more is the same fingerprint a fully-redacted org leaves
// once its templated name doesn't happen to match REDACTED_ORG_NAME_PATTERN.
const MIN_BLANK_FIELDS_TO_REJECT = 2

function isBlank(value: string | number | null): boolean {
  if (value === null) return true
  return typeof value === 'string' && value.trim().length === 0
}

/**
 * True when 2 or more of a company's core firmographic fields
 * (domain/city/state/country/founded year) are blank — a data-sparsity
 * signal that, combined with isRedactedOrgName, flags Apollo's
 * confidential-org redaction even when the name itself doesn't match the
 * known template.
 */
export function hasTooManyBlankCompanyFields(company: CompanyFieldPresence): boolean {
  const fields: (string | number | null)[] = [
    company.companyDomain,
    company.city,
    company.state,
    company.country,
    company.foundedYear,
  ]
  return fields.filter(isBlank).length >= MIN_BLANK_FIELDS_TO_REJECT
}
