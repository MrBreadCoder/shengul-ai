import { describe, it, expect } from 'vitest'
import { buildKnowledgeQueryText, MAX_SECONDARY_CHARS } from './build-query'

describe('buildKnowledgeQueryText', () => {
  it('should return just the primary text when there is no secondary text', () => {
    expect(buildKnowledgeQueryText({ primary: 'What are your prices?' })).toBe('What are your prices?')
  })

  it('should append secondary text after primary', () => {
    const result = buildKnowledgeQueryText({ primary: 'What are your prices?', secondary: ['We sell widgets.'] })
    expect(result).toBe('What are your prices? We sell widgets.')
  })

  it('should truncate secondary text to MAX_SECONDARY_CHARS when primary is present', () => {
    const longSecondary = 'x'.repeat(1000)
    const result = buildKnowledgeQueryText({ primary: 'question', secondary: [longSecondary] })
    expect(result).toBe(`question ${'x'.repeat(MAX_SECONDARY_CHARS)}`)
  })

  it('should not truncate secondary text when primary is empty (dossier-as-primary case)', () => {
    const longSecondary = 'x'.repeat(1000)
    const result = buildKnowledgeQueryText({ primary: '', secondary: [longSecondary] })
    expect(result).toBe(longSecondary)
  })

  it('should filter out empty secondary parts and join the rest with a space', () => {
    const result = buildKnowledgeQueryText({ primary: 'q', secondary: ['', '  ', 'fact one', 'fact two'] })
    expect(result).toBe('q fact one fact two')
  })

  it('should return an empty string when both primary and secondary are empty', () => {
    expect(buildKnowledgeQueryText({ primary: '  ', secondary: ['', '  '] })).toBe('')
  })
})
