import { describe, it, expect } from 'vitest'
import { chunkText, CHUNK_SIZE_CHARS, CHUNK_OVERLAP_CHARS } from './chunk-text'

describe('chunkText', () => {
  it('should return an empty array for empty or whitespace-only text', () => {
    expect(chunkText('')).toEqual([])
    expect(chunkText('   \n  ')).toEqual([])
  })

  it('should return a single chunk when text is shorter than chunkSize', () => {
    const result = chunkText('short text', 1000, 100)
    expect(result).toEqual([{ index: 0, content: 'short text' }])
  })

  it('should split long text into overlapping chunks', () => {
    const text = 'a'.repeat(2500)
    const result = chunkText(text, 1000, 100)
    expect(result.length).toBe(3)
    expect(result[0]!.content.length).toBe(1000)
    expect(result[1]!.content.length).toBe(1000)
    // Last chunk covers the remainder: starts at 1800 (2*(1000-100)), ends at 2500.
    expect(result[2]!.content.length).toBe(700)
    expect(result.map((c) => c.index)).toEqual([0, 1, 2])
  })

  it('should overlap consecutive chunks by exactly the overlap amount', () => {
    const text = '0123456789'.repeat(300) // 3000 chars
    const result = chunkText(text, 1000, 100)
    const firstChunkTail = result[0]!.content.slice(-100)
    const secondChunkHead = result[1]!.content.slice(0, 100)
    expect(firstChunkTail).toBe(secondChunkHead)
  })

  it('should trim leading/trailing whitespace before chunking', () => {
    const result = chunkText('  hello world  ', 1000, 100)
    expect(result).toEqual([{ index: 0, content: 'hello world' }])
  })

  it('should use the default chunk size and overlap constants when not provided', () => {
    const text = 'x'.repeat(CHUNK_SIZE_CHARS + 50)
    const result = chunkText(text)
    expect(result.length).toBe(2)
    expect(CHUNK_SIZE_CHARS).toBe(1000)
    expect(CHUNK_OVERLAP_CHARS).toBe(100)
  })
})
