import { describe, it, expect } from 'vitest'
import {
  splitFullName,
  toCompanyInput,
  toContactInput,
  toDealTitle,
  toCreationNote,
  isSyncableLead,
  type SyncableLead,
} from './mapping'

function lead(overrides: Partial<SyncableLead> = {}): SyncableLead {
  return {
    email: 'ada@example.com',
    full_name: 'Ada Lovelace',
    title: 'CTO',
    linkedin_url: 'https://linkedin.com/in/ada',
    company_name: 'Analytical Engines',
    email_status: 'verified',
    status: 'active',
    ...overrides,
  }
}

describe('splitFullName', () => {
  it('should split first and last when given two names', () => {
    expect(splitFullName('Ada Lovelace')).toEqual({ firstName: 'Ada', lastName: 'Lovelace' })
  })

  it('should keep everything after the first space as the last name', () => {
    expect(splitFullName('Ada King Lovelace')).toEqual({ firstName: 'Ada', lastName: 'King Lovelace' })
  })

  it('should return a null last name when given a single word', () => {
    expect(splitFullName('Ada')).toEqual({ firstName: 'Ada', lastName: null })
  })

  it('should return nulls when given an empty or whitespace-only name', () => {
    expect(splitFullName('   ')).toEqual({ firstName: null, lastName: null })
  })

  it('should ignore repeated and surrounding whitespace', () => {
    expect(splitFullName('  Ada   Lovelace  ')).toEqual({ firstName: 'Ada', lastName: 'Lovelace' })
  })
})

describe('toCompanyInput', () => {
  it('should carry the case company name and domain through', () => {
    expect(toCompanyInput({ company_name: 'Acme', company_domain: 'acme.com' })).toEqual({
      name: 'Acme',
      domain: 'acme.com',
    })
  })

  it('should preserve a null domain rather than inventing one', () => {
    expect(toCompanyInput({ company_name: 'Acme', company_domain: null })).toEqual({
      name: 'Acme',
      domain: null,
    })
  })
})

describe('toContactInput', () => {
  it('should map a fully populated lead', () => {
    expect(toContactInput(lead())).toEqual({
      email: 'ada@example.com',
      firstName: 'Ada',
      lastName: 'Lovelace',
      title: 'CTO',
      linkedinUrl: 'https://linkedin.com/in/ada',
      companyName: 'Analytical Engines',
    })
  })

  it('should preserve nulls for the optional fields', () => {
    expect(toContactInput(lead({ title: null, linkedin_url: null, company_name: null }))).toMatchObject({
      title: null,
      linkedinUrl: null,
      companyName: null,
    })
  })
})

describe('toDealTitle', () => {
  it('should combine the company name and the campaign name', () => {
    expect(toDealTitle('Acme', 'Q3 Outbound')).toBe('Acme — Q3 Outbound')
  })

  it('should fall back to the company name alone when there is no campaign name', () => {
    expect(toDealTitle('Acme', null)).toBe('Acme')
  })
})

describe('toCreationNote', () => {
  it('should include the dossier summary, the case link, and each contact line', () => {
    const note = toCreationNote({
      summary: 'Scaling their support team.',
      caseUrl: 'https://app.example.com/cases/abc',
      companyDomain: 'acme.com',
      leads: [lead()],
    })

    expect(note).toContain('Scaling their support team.')
    expect(note).toContain('https://app.example.com/cases/abc')
    expect(note).toContain('acme.com')
    expect(note).toContain('Ada Lovelace')
    expect(note).toContain('CTO')
    expect(note).toContain('https://linkedin.com/in/ada')
  })

  it('should omit the summary line when the case has no dossier summary', () => {
    const note = toCreationNote({
      summary: null,
      caseUrl: 'https://app.example.com/cases/abc',
      companyDomain: null,
      leads: [lead({ title: null, linkedin_url: null })],
    })

    expect(note).toContain('https://app.example.com/cases/abc')
    expect(note).toContain('Ada Lovelace')
    expect(note).not.toContain('Summary:')
  })
})

describe('isSyncableLead', () => {
  it('should accept an active, verified lead with an email', () => {
    expect(isSyncableLead(lead())).toBe(true)
  })

  it('should reject a lead whose email is not verified', () => {
    expect(isSyncableLead(lead({ email_status: 'risky' }))).toBe(false)
  })

  it('should reject a lead that is no longer active', () => {
    expect(isSyncableLead(lead({ status: 'parked' }))).toBe(false)
  })

  it('should reject a lead with no email address', () => {
    expect(isSyncableLead(lead({ email: null }))).toBe(false)
  })
})
