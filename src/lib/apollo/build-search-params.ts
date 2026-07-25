import type { ApolloIcpFilters } from './types'

export function buildPeopleSearchParams(
  icp: ApolloIcpFilters,
  page: number,
  perPage: number,
  organizationDomains: string[] = [],
): Record<string, string | string[]> {
  const params: Record<string, string | string[]> = {
    page: String(page),
    per_page: String(perPage),
  }
  if (icp.personTitles.length > 0) {
    params['person_titles[]'] = icp.personTitles
  }
  if (icp.organizationLocations.length > 0) {
    params['organization_locations[]'] = icp.organizationLocations
  }
  if (icp.excludeOrganizationLocations.length > 0) {
    // organization_not_locations[] — confirmed Apollo exclude filter, see
    // "Apollo API research" in docs/superpowers/plans/2026-07-21-apollo-exclude-filters.md.
    params['organization_not_locations[]'] = icp.excludeOrganizationLocations
  }
  if (icp.employeeRangeMin !== null && icp.employeeRangeMax !== null) {
    params['organization_num_employees_ranges[]'] = [`${icp.employeeRangeMin},${icp.employeeRangeMax}`]
  }
  if (icp.keywords.length > 0) {
    params.q_keywords = icp.keywords.join(' ')
  }
  if (icp.personSeniorities.length > 0) {
    params['person_seniorities[]'] = icp.personSeniorities
  }
  if (icp.contactEmailStatuses.length > 0) {
    params['contact_email_status[]'] = icp.contactEmailStatuses
  }
  // Second-pass targeting (src/lib/pipeline/discover.ts runSecondPass):
  // restricts the search to specific companies so discovery can go back for
  // a second contact. Confirmed against Apollo's People Search API docs
  // (docs.apollo.io/reference/people-api-search).
  if (organizationDomains.length > 0) {
    params['q_organization_domains_list[]'] = organizationDomains
  }
  return params
}
