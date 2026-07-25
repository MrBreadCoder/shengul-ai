import { describe, expect, it } from 'vitest'
import {
  absoluteUrl,
  CONTENT_PUBLISHED_AT,
  CONTENT_UPDATED_AT,
  LANDING_DESCRIPTION,
  META_DESCRIPTION_MAX_LENGTH,
  META_DESCRIPTION_MIN_LENGTH,
  SITE_DESCRIPTION,
  SITE_TITLE,
} from '@/lib/seo/site'

describe('meta descriptions', () => {
  const descriptions: readonly [string, string][] = [
    ['SITE_DESCRIPTION', SITE_DESCRIPTION],
    ['LANDING_DESCRIPTION', LANDING_DESCRIPTION],
  ]

  it.each(descriptions)('should keep %s inside the 50–160 character window', (_name, value) => {
    expect(value.length).toBeGreaterThanOrEqual(META_DESCRIPTION_MIN_LENGTH)
    expect(value.length).toBeLessThanOrEqual(META_DESCRIPTION_MAX_LENGTH)
  })

  it('should keep the two descriptions distinct so pages do not compete', () => {
    expect(SITE_DESCRIPTION).not.toEqual(LANDING_DESCRIPTION)
  })
})

describe('freshness constants', () => {
  it('should expose parseable ISO timestamps', () => {
    expect(Number.isNaN(Date.parse(CONTENT_PUBLISHED_AT))).toBe(false)
    expect(Number.isNaN(Date.parse(CONTENT_UPDATED_AT))).toBe(false)
  })

  it('should not claim the content was updated before it was published', () => {
    expect(Date.parse(CONTENT_UPDATED_AT)).toBeGreaterThanOrEqual(Date.parse(CONTENT_PUBLISHED_AT))
  })
})

describe('SITE_TITLE', () => {
  it('should fit a search result once the brand suffix is appended', () => {
    expect(`${SITE_TITLE} · Shengul AI`.length).toBeLessThanOrEqual(60)
  })
})

describe('absoluteUrl', () => {
  it('should join an origin and a path when both are well formed', () => {
    expect(absoluteUrl('https://example.com', '/login')).toBe('https://example.com/login')
  })

  it('should strip trailing slashes from the origin', () => {
    expect(absoluteUrl('https://example.com//', '/login')).toBe('https://example.com/login')
  })

  it('should add a missing leading slash to the path', () => {
    expect(absoluteUrl('https://example.com', 'llms.txt')).toBe('https://example.com/llms.txt')
  })

  it('should return the origin with a trailing slash for the root path', () => {
    expect(absoluteUrl('https://example.com', '/')).toBe('https://example.com/')
    expect(absoluteUrl('https://example.com', '')).toBe('https://example.com/')
  })
})
