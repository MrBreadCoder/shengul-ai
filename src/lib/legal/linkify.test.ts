import { describe, expect, it } from 'vitest'
import { splitLegalReferences } from '@/lib/legal/linkify'

describe('splitLegalReferences', () => {
  it('should return a single text segment when there is no reference', () => {
    expect(splitLegalReferences('We do not sell personal information.')).toEqual([
      { kind: 'text', value: 'We do not sell personal information.' },
    ])
  })

  it('should split a reference out of the surrounding prose', () => {
    expect(splitLegalReferences('See /legal/subprocessors for the list.')).toEqual([
      { kind: 'text', value: 'See ' },
      { kind: 'link', value: '/legal/subprocessors', href: '/legal/subprocessors' },
      { kind: 'text', value: ' for the list.' },
    ])
  })

  it('should stop the link before trailing sentence punctuation', () => {
    const segments = splitLegalReferences('Our notice is at /legal/privacy-policy.')

    expect(segments).toEqual([
      { kind: 'text', value: 'Our notice is at ' },
      { kind: 'link', value: '/legal/privacy-policy', href: '/legal/privacy-policy' },
      { kind: 'text', value: '.' },
    ])
  })

  it('should split every reference when a sentence names more than one', () => {
    const segments = splitLegalReferences('/legal/terms-of-service and /legal/cookie-policy')

    expect(segments.filter((segment) => segment.kind === 'link')).toHaveLength(2)
  })

  it('should emit no trailing text segment when the reference ends the string', () => {
    expect(splitLegalReferences('Listed at /legal/subprocessors')).toEqual([
      { kind: 'text', value: 'Listed at ' },
      { kind: 'link', value: '/legal/subprocessors', href: '/legal/subprocessors' },
    ])
  })

  it('should return nothing for an empty string', () => {
    expect(splitLegalReferences('')).toEqual([])
  })
})
