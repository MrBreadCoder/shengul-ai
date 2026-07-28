import { describe, it, expect } from 'vitest'
import { chooseReadStrategy, RESOURCE_PDF_TEXT_FLOOR } from './read-strategy'

describe('chooseReadStrategy', () => {
  it('should read plain text and markdown as text', () => {
    expect(chooseReadStrategy('text/plain')).toBe('text')
    expect(chooseReadStrategy('text/markdown')).toBe('text')
  })

  it('should read svg as text because its markup is its content', () => {
    expect(chooseReadStrategy('image/svg+xml')).toBe('text')
  })

  it('should use the extracted text when a pdf has enough of it', () => {
    expect(chooseReadStrategy('application/pdf', 'a'.repeat(RESOURCE_PDF_TEXT_FLOOR))).toBe('text')
  })

  it('should fall back to vision when a pdf is one char short of the floor', () => {
    expect(chooseReadStrategy('application/pdf', 'a'.repeat(RESOURCE_PDF_TEXT_FLOOR - 1))).toBe('vision')
  })

  it('should fall back to vision when a pdf yields only whitespace', () => {
    expect(chooseReadStrategy('application/pdf', '   \n\n  \t ')).toBe('vision')
  })

  it('should fall back to vision when pdf extraction produced nothing at all', () => {
    expect(chooseReadStrategy('application/pdf')).toBe('vision')
  })

  it('should use vision for the image formats gemini accepts', () => {
    expect(chooseReadStrategy('image/png')).toBe('vision')
    expect(chooseReadStrategy('image/jpeg')).toBe('vision')
    expect(chooseReadStrategy('image/webp')).toBe('vision')
  })

  it('should report gif as unsupported because gemini image input rejects it', () => {
    expect(chooseReadStrategy('image/gif')).toBe('unsupported')
  })

  it('should report an unknown mime type as unsupported', () => {
    expect(chooseReadStrategy('application/zip')).toBe('unsupported')
  })
})
