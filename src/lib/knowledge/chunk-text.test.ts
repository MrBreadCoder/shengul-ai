import { describe, it, expect } from 'vitest'
import { chunkText, CHUNK_SIZE_CHARS, CHUNK_OVERLAP_CHARS, MIN_CHUNK_CHARS } from './chunk-text'

describe('chunkText', () => {
  it('should return an empty array for empty or whitespace-only text', () => {
    expect(chunkText('')).toEqual([])
    expect(chunkText('   \n  ')).toEqual([])
  })

  it('should keep a single paragraph that is long enough to clear the minimum chunk size', () => {
    const result = chunkText('This is a short paragraph.', 1000, 100)
    expect(result).toEqual([{ index: 0, content: 'This is a short paragraph.' }])
  })

  it('should pack multiple short paragraphs into one chunk when they fit together', () => {
    const text = 'First paragraph.\n\nSecond paragraph.\n\nThird paragraph.'
    const result = chunkText(text, 1000, 100)
    expect(result).toEqual([{ index: 0, content: text }])
  })

  it('should split paragraphs that do not fit together into separate chunks with a whitespace-snapped overlap prefix', () => {
    const paragraphA = Array.from({ length: 100 }, (_, i) => `alpha${i}`).join(' ')
    const paragraphB = Array.from({ length: 100 }, (_, i) => `beta${i}`).join(' ')
    const result = chunkText(`${paragraphA}\n\n${paragraphB}`, 1000, 100)

    expect(result.length).toBe(2)
    expect(result[0]!.content).toBe(paragraphA)
    expect(result[1]!.content.endsWith(paragraphB)).toBe(true)
    expect(result[1]!.content).not.toBe(paragraphB)

    const overlapPrefix = result[1]!.content.slice(0, result[1]!.content.length - paragraphB.length - 2)
    const boundaryIndex = paragraphA.indexOf(overlapPrefix)
    expect(boundaryIndex).toBeGreaterThanOrEqual(0)
    expect(boundaryIndex === 0 || paragraphA[boundaryIndex - 1] === ' ').toBe(true)
  })

  it('should split a single oversized paragraph at whitespace, never mid-word', () => {
    const words = Array.from({ length: 300 }, (_, i) => `token${i}`)
    const text = words.join(' ')
    const result = chunkText(text, 1000, 100)

    expect(result.length).toBeGreaterThan(1)
    for (const chunk of result) {
      for (const piece of chunk.content.split('\n\n')) {
        for (const word of piece.trim().split(/\s+/)) {
          if (word.length === 0) continue
          expect(words).toContain(word)
        }
      }
    }
  })

  it('should drop chunks shorter than MIN_CHUNK_CHARS non-whitespace characters', () => {
    expect(chunkText('ok', 1000, 100)).toEqual([])
    expect(MIN_CHUNK_CHARS).toBe(20)
  })

  it('should use the default chunk size and overlap constants when not provided', () => {
    expect(CHUNK_SIZE_CHARS).toBe(1000)
    expect(CHUNK_OVERLAP_CHARS).toBe(100)
    const paragraphA = Array.from({ length: 100 }, (_, i) => `alpha${i}`).join(' ')
    const paragraphB = Array.from({ length: 100 }, (_, i) => `beta${i}`).join(' ')
    const result = chunkText(`${paragraphA}\n\n${paragraphB}`)
    expect(result.length).toBe(2)
  })
})
