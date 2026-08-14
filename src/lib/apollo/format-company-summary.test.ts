import { describe, it, expect } from 'vitest'
import { formatCompanySummary, parseCompanySocialsFromRaw, parsePersonSocialsFromRaw, type CompanyFirmographics } from './format-company-summary'

const empty: CompanyFirmographics = {
  industry: null, employeeCount: null, foundedYear: null, description: null,
  city: null, state: null, country: null,
}

describe('formatCompanySummary', () => {
  it('should return null when every field is null', () => {
    const result = formatCompanySummary('Acme Corp', empty)

    expect(result).toBeNull()
  })

  it('should render one sentence per section when every field is present', () => {
    const firmographics: CompanyFirmographics = {
      industry: 'Software', employeeCount: 120, foundedYear: 2016,
      description: 'Acme builds workflow automation for logistics teams.',
      city: 'Austin', state: 'TX', country: 'United States',
    }

    const result = formatCompanySummary('Acme Corp', firmographics)

    expect(result).toBe(
      'Acme Corp — Software industry, ~120 employees, founded 2016. ' +
      'Acme builds workflow automation for logistics teams. ' +
      'Based in Austin, TX, United States.',
    )
  })

  it('should omit the description and founded year sections when they are null', () => {
    const firmographics: CompanyFirmographics = {
      industry: 'Software', employeeCount: 120, foundedYear: null, description: null,
      city: 'Austin', state: 'TX', country: 'United States',
    }

    const result = formatCompanySummary('Acme Corp', firmographics)

    expect(result).toBe('Acme Corp — Software industry, ~120 employees. Based in Austin, TX, United States.')
  })

  it('should prefix the company name onto a location-only summary', () => {
    const firmographics: CompanyFirmographics = {
      ...empty, city: 'Austin', state: 'TX', country: 'United States',
    }

    const result = formatCompanySummary('Acme Corp', firmographics)

    expect(result).toBe('Acme Corp — Based in Austin, TX, United States.')
  })

  it('should treat an employee count of zero as a real value, not a missing one', () => {
    const firmographics: CompanyFirmographics = { ...empty, employeeCount: 0 }

    const result = formatCompanySummary('Acme Corp', firmographics)

    expect(result).toBe('Acme Corp — ~0 employees.')
  })

  it('should omit missing location parts without leaving stray punctuation', () => {
    const firmographics: CompanyFirmographics = { ...empty, state: 'TX' }

    const result = formatCompanySummary('Acme Corp', firmographics)

    expect(result).toBe('Acme Corp — Based in TX.')
  })

  it('should render a description-only summary ending with proper punctuation', () => {
    const firmographics: CompanyFirmographics = {
      ...empty, description: 'Acme builds workflow automation',
    }

    const result = formatCompanySummary('Acme Corp', firmographics)

    expect(result).toBe('Acme Corp — Acme builds workflow automation.')
  })
})

describe('parseCompanySocialsFromRaw', () => {
  it('should map organizationLinkedinUrl and organizationTwitterUrl when present', () => {
    const result = parseCompanySocialsFromRaw({
      organizationLinkedinUrl: 'https://linkedin.com/company/acme',
      organizationTwitterUrl: 'https://x.com/acme',
    })
    expect(result).toEqual({ linkedinUrl: 'https://linkedin.com/company/acme', twitterUrl: 'https://x.com/acme' })
  })

  it('should return all-null when the fields are absent', () => {
    const result = parseCompanySocialsFromRaw({ organizationName: 'Acme' })
    expect(result).toEqual({ linkedinUrl: null, twitterUrl: null })
  })

  it('should return all-null (not throw) for a non-object raw value', () => {
    const result = parseCompanySocialsFromRaw(null)
    expect(result).toEqual({ linkedinUrl: null, twitterUrl: null })
  })
})

describe('parsePersonSocialsFromRaw', () => {
  it('should map twitterUrl when present', () => {
    const result = parsePersonSocialsFromRaw({ twitterUrl: 'https://x.com/janedoe' })
    expect(result).toEqual({ twitterUrl: 'https://x.com/janedoe' })
  })

  it('should return null when absent', () => {
    const result = parsePersonSocialsFromRaw({ firstName: 'Jane' })
    expect(result).toEqual({ twitterUrl: null })
  })
})
