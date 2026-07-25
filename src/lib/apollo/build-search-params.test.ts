import { describe, it, expect } from 'vitest'
import { buildPeopleSearchParams } from './build-search-params'
import type { ApolloIcpFilters } from './types'

const emptyIcp: ApolloIcpFilters = {
  personTitles: [],
  organizationLocations: [],
  employeeRangeMin: null,
  employeeRangeMax: null,
  keywords: [],
  personSeniorities: [],
  contactEmailStatuses: [],
  excludeOrganizationLocations: [],
  excludeKeywords: [],
}

describe('buildPeopleSearchParams', () => {
  it('should always include page and per_page', () => {
    const params = buildPeopleSearchParams(emptyIcp, 2, 25)
    expect(params.page).toBe('2')
    expect(params.per_page).toBe('25')
  })

  it('should omit empty filters', () => {
    const params = buildPeopleSearchParams(emptyIcp, 1, 25)
    expect(params['person_titles[]']).toBeUndefined()
    expect(params['organization_locations[]']).toBeUndefined()
    expect(params['organization_num_employees_ranges[]']).toBeUndefined()
    expect(params.q_keywords).toBeUndefined()
  })

  it('should pass person titles and organization locations through as arrays', () => {
    const icp: ApolloIcpFilters = {
      ...emptyIcp,
      personTitles: ['vp sales', 'founder'],
      organizationLocations: ['united states'],
    }
    const params = buildPeopleSearchParams(icp, 1, 25)
    expect(params['person_titles[]']).toEqual(['vp sales', 'founder'])
    expect(params['organization_locations[]']).toEqual(['united states'])
  })

  it('should format the employee range as a single "min,max" string when both bounds are set', () => {
    const icp: ApolloIcpFilters = { ...emptyIcp, employeeRangeMin: 50, employeeRangeMax: 200 }
    const params = buildPeopleSearchParams(icp, 1, 25)
    expect(params['organization_num_employees_ranges[]']).toEqual(['50,200'])
  })

  it('should omit the employee range when only one bound is set', () => {
    const icp: ApolloIcpFilters = { ...emptyIcp, employeeRangeMin: 50, employeeRangeMax: null }
    const params = buildPeopleSearchParams(icp, 1, 25)
    expect(params['organization_num_employees_ranges[]']).toBeUndefined()
  })

  it('should join keywords into a single space-separated q_keywords string', () => {
    const icp: ApolloIcpFilters = { ...emptyIcp, keywords: ['fintech', 'payments'] }
    const params = buildPeopleSearchParams(icp, 1, 25)
    expect(params.q_keywords).toBe('fintech payments')
  })

  it('should omit the organization domains filter when none are given', () => {
    const params = buildPeopleSearchParams(emptyIcp, 1, 25)
    expect(params['q_organization_domains_list[]']).toBeUndefined()
  })

  it('should pass organization domains through as an array when targeting specific companies', () => {
    const params = buildPeopleSearchParams(emptyIcp, 1, 25, ['acme.com', 'beta.io'])
    expect(params['q_organization_domains_list[]']).toEqual(['acme.com', 'beta.io'])
  })

  it('should omit person seniorities filter when none are given', () => {
    const params = buildPeopleSearchParams(emptyIcp, 1, 25)
    expect(params['person_seniorities[]']).toBeUndefined()
  })

  it('should pass person seniorities through as an array', () => {
    const icp: ApolloIcpFilters = { ...emptyIcp, personSeniorities: ['vp', 'director'] }
    const params = buildPeopleSearchParams(icp, 1, 25)
    expect(params['person_seniorities[]']).toEqual(['vp', 'director'])
  })

  it('should omit contact email status filter when none are given', () => {
    const params = buildPeopleSearchParams(emptyIcp, 1, 25)
    expect(params['contact_email_status[]']).toBeUndefined()
  })

  it('should pass contact email statuses through as an array', () => {
    const icp: ApolloIcpFilters = { ...emptyIcp, contactEmailStatuses: ['verified', 'likely to engage'] }
    const params = buildPeopleSearchParams(icp, 1, 25)
    expect(params['contact_email_status[]']).toEqual(['verified', 'likely to engage'])
  })

  it('should omit the exclude-locations filter when none are given', () => {
    const params = buildPeopleSearchParams(emptyIcp, 1, 25)
    expect(params['organization_not_locations[]']).toBeUndefined()
  })

  it('should pass excluded organization locations through as organization_not_locations[]', () => {
    const icp: ApolloIcpFilters = { ...emptyIcp, excludeOrganizationLocations: ['ireland', 'india'] }
    const params = buildPeopleSearchParams(icp, 1, 25)
    expect(params['organization_not_locations[]']).toEqual(['ireland', 'india'])
  })
})
