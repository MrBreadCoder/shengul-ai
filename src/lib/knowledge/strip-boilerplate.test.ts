import { describe, it, expect } from 'vitest'
import { stripBoilerplateParagraphs } from './strip-boilerplate'

describe('stripBoilerplateParagraphs', () => {
  it('should return content unchanged when there are fewer than 2 siblings', () => {
    const content = 'Nav menu.\n\nUnique page content.'
    expect(stripBoilerplateParagraphs(content, [])).toBe(content)
    expect(stripBoilerplateParagraphs(content, ['Nav menu.\n\nOther page.'])).toBe(content)
  })

  it('should strip a paragraph that appears in every sibling (2-sibling client)', () => {
    const content = 'Nav menu.\n\nPage A unique content.'
    const siblings = ['Nav menu.\n\nPage B content.', 'Nav menu.\n\nPage C content.']
    const result = stripBoilerplateParagraphs(content, siblings)
    expect(result).toBe('Page A unique content.')
  })

  it('should keep a paragraph that only matches one of several siblings', () => {
    const content = 'Nav menu.\n\nShared with just one page.'
    const siblings = [
      'Nav menu.\n\nOther A.',
      'Nav menu.\n\nOther B.',
      'Nav menu.\n\nShared with just one page.',
    ]
    const result = stripBoilerplateParagraphs(content, siblings)
    expect(result).toBe('Shared with just one page.')
  })

  it('should keep unique content untouched', () => {
    const content = 'Completely unique paragraph.'
    const siblings = ['Something else.', 'Something else too.']
    expect(stripBoilerplateParagraphs(content, siblings)).toBe(content)
  })

  it('should treat whitespace-only differences as the same paragraph', () => {
    const content = 'Nav   menu.\n\nUnique content.'
    const siblings = ['Nav menu.\n\nOther.', 'Nav menu.\n\nOther2.']
    const result = stripBoilerplateParagraphs(content, siblings)
    expect(result).toBe('Unique content.')
  })
})
