import { describe, it, expect } from 'vitest'
import { normalizeCompanyName } from './company-key'

describe('normalizeCompanyName', () => {
  it('should lowercase the name', () => {
    expect(normalizeCompanyName('ACME')).toBe('acme')
  })

  it('should strip a trailing legal suffix', () => {
    expect(normalizeCompanyName('Acme Inc.')).toBe('acme')
    expect(normalizeCompanyName('Acme, LLC')).toBe('acme')
    expect(normalizeCompanyName('Acme GmbH')).toBe('acme')
  })

  it('should collapse repeated whitespace', () => {
    expect(normalizeCompanyName('  Multi   Space   Co  ')).toBe('multi space')
  })

  it('should preserve multi-word names with no legal suffix', () => {
    expect(normalizeCompanyName('Foo Bar Studios')).toBe('foo bar studios')
  })

  it('should return an empty string for a name that is only a legal suffix', () => {
    expect(normalizeCompanyName('Inc')).toBe('')
  })

  it('should preserve a legal-suffix word that is not trailing', () => {
    expect(normalizeCompanyName('Corp Motors')).toBe('corp motors')
  })

  it('should strip only the trailing legal-suffix word, keeping an earlier one intact', () => {
    expect(normalizeCompanyName('Corp Motors Inc')).toBe('corp motors')
  })
})
