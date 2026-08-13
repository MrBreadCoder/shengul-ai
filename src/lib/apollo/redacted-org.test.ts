import { describe, it, expect } from 'vitest'
import { isRedactedOrgName, hasTooManyBlankCompanyFields } from './redacted-org'

describe('isRedactedOrgName', () => {
  it('should return true for the "Private <industry> Based in <place>" placeholder Apollo returns for confidential orgs', () => {
    expect(isRedactedOrgName('Private Airline Based in UAE')).toBe(true)
  })

  it('should return true for a "Confidential" variant of the same placeholder', () => {
    expect(isRedactedOrgName('Confidential Company Based in Riyadh')).toBe(true)
  })

  it('should be case-insensitive', () => {
    expect(isRedactedOrgName('private equity firm based in new york')).toBe(true)
  })

  it('should return false for a real company name that happens to start with "Private"', () => {
    expect(isRedactedOrgName('PrivateJet Charter Services')).toBe(false)
  })

  it('should return false for a real company name containing "private" without the "based in" placeholder phrase', () => {
    expect(isRedactedOrgName('Private Bank of America')).toBe(false)
  })

  it('should return false for an ordinary company name', () => {
    expect(isRedactedOrgName('Royal Jet')).toBe(false)
  })

  it('should return false for null', () => {
    expect(isRedactedOrgName(null)).toBe(false)
  })
})

describe('hasTooManyBlankCompanyFields', () => {
  it('should return true when domain, city, state, and country are all null (only founded year present)', () => {
    expect(
      hasTooManyBlankCompanyFields({
        companyDomain: null,
        city: null,
        state: null,
        country: null,
        foundedYear: 1990,
      }),
    ).toBe(true)
  })

  it('should return true when exactly 2 of the 5 fields are blank', () => {
    expect(
      hasTooManyBlankCompanyFields({
        companyDomain: 'acme.com',
        city: 'Austin',
        state: 'TX',
        country: null,
        foundedYear: null,
      }),
    ).toBe(true)
  })

  it('should return false when only 1 of the 5 fields is blank', () => {
    expect(
      hasTooManyBlankCompanyFields({
        companyDomain: 'acme.com',
        city: 'Austin',
        state: 'TX',
        country: 'USA',
        foundedYear: null,
      }),
    ).toBe(false)
  })

  it('should return false when every field is populated', () => {
    expect(
      hasTooManyBlankCompanyFields({
        companyDomain: 'acme.com',
        city: 'Austin',
        state: 'TX',
        country: 'USA',
        foundedYear: 1990,
      }),
    ).toBe(false)
  })

  it('should treat an empty or whitespace-only string as blank, not merely null', () => {
    expect(
      hasTooManyBlankCompanyFields({
        companyDomain: 'acme.com',
        city: '   ',
        state: '',
        country: 'USA',
        foundedYear: 1990,
      }),
    ).toBe(true)
  })
})
