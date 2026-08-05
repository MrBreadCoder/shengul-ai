import { describe, it, expect } from 'vitest'
import { matchesExcludedKeywords } from './exclude-keywords'

describe('matchesExcludedKeywords', () => {
  it('should return false when no keywords are excluded', () => {
    expect(matchesExcludedKeywords({ title: 'VP Sales', organizationName: 'Acme Staffing' }, [])).toBe(false)
  })

  it('should return true when the organization name contains an excluded keyword, case-insensitively', () => {
    expect(matchesExcludedKeywords({ title: 'VP Sales', organizationName: 'Acme Staffing Agency' }, ['staffing'])).toBe(true)
    expect(matchesExcludedKeywords({ title: 'VP Sales', organizationName: 'ACME STAFFING' }, ['Staffing'])).toBe(true)
  })

  it('should return true when the title contains an excluded keyword', () => {
    expect(matchesExcludedKeywords({ title: 'Recruiting Consultant', organizationName: 'Acme' }, ['recruiting'])).toBe(true)
  })

  it('should return false when neither field contains any excluded keyword', () => {
    expect(matchesExcludedKeywords({ title: 'VP Sales', organizationName: 'Acme Fintech' }, ['staffing', 'agency'])).toBe(false)
  })

  it('should treat null title and organizationName as empty strings rather than throwing', () => {
    expect(matchesExcludedKeywords({ title: null, organizationName: null }, ['staffing'])).toBe(false)
  })

  it('should not match a keyword that only appears as a substring of a larger word', () => {
    expect(matchesExcludedKeywords({ title: 'VP Sales', organizationName: 'Emergency Medical Group' }, ['agency'])).toBe(false)
  })

  it('should match a multi-word keyword phrase as a whole unit', () => {
    expect(matchesExcludedKeywords({ title: 'VP Sales', organizationName: 'Acme Staffing Agency' }, ['staffing agency'])).toBe(true)
  })

  it('should trim whitespace and ignore blank keywords', () => {
    expect(matchesExcludedKeywords({ title: 'VP Sales', organizationName: 'Acme Staffing' }, ['  staffing  '])).toBe(true)
    expect(matchesExcludedKeywords({ title: 'VP Sales', organizationName: 'Acme Fintech' }, ['', '   '])).toBe(false)
  })

  it('should match a keyword that only appears in organizationIndustry', () => {
    expect(
      matchesExcludedKeywords(
        { title: 'VP Sales', organizationName: 'Acme Corp', organizationIndustry: 'Staffing & Recruiting' },
        ['staffing'],
      ),
    ).toBe(true)
  })

  it('should match a keyword that only appears in organizationDescription', () => {
    expect(
      matchesExcludedKeywords(
        {
          title: 'VP Sales',
          organizationName: 'Acme Corp',
          organizationDescription: 'We are a staffing agency for finance teams.',
        },
        ['staffing agency'],
      ),
    ).toBe(true)
  })

  it('should treat missing organizationIndustry and organizationDescription as empty strings rather than throwing', () => {
    expect(
      matchesExcludedKeywords({ title: 'VP Sales', organizationName: 'Acme Fintech' }, ['staffing']),
    ).toBe(false)
    expect(
      matchesExcludedKeywords(
        { title: 'VP Sales', organizationName: 'Acme Fintech', organizationIndustry: null, organizationDescription: null },
        ['staffing'],
      ),
    ).toBe(false)
  })
})
