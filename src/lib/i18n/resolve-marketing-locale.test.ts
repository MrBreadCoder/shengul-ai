import { describe, it, expect } from 'vitest'
import type { NextRequest } from 'next/server'
import { MARKETING_LOCALE_COOKIE, resolveMarketingLocale } from './resolve-marketing-locale'

function fakeRequest({
  cookie,
  country,
  acceptLanguage,
}: {
  cookie?: string
  country?: string
  acceptLanguage?: string
}): NextRequest {
  const headerMap = new Map<string, string>()
  if (country) headerMap.set('x-vercel-ip-country', country)
  if (acceptLanguage) headerMap.set('accept-language', acceptLanguage)

  return {
    headers: { get: (name: string) => headerMap.get(name) ?? null },
    cookies: {
      get: (name: string) =>
        name === MARKETING_LOCALE_COOKIE && cookie !== undefined ? { name, value: cookie } : undefined,
    },
  } as unknown as NextRequest
}

describe('resolveMarketingLocale', () => {
  it('should honor the manual override cookie over geo and language', () => {
    const request = fakeRequest({ cookie: 'en', country: 'TR', acceptLanguage: 'tr' })
    expect(resolveMarketingLocale(request)).toBe('en')
  })

  it('should ignore an unsupported cookie value and fall through to geo', () => {
    const request = fakeRequest({ cookie: 'fr', country: 'TR' })
    expect(resolveMarketingLocale(request)).toBe('tr')
  })

  it('should resolve to tr when the geo header says Turkey', () => {
    expect(resolveMarketingLocale(fakeRequest({ country: 'TR' }))).toBe('tr')
  })

  it('should ignore a non-Turkey geo header and fall back to Accept-Language', () => {
    const request = fakeRequest({ country: 'DE', acceptLanguage: 'tr-TR,tr;q=0.9' })
    expect(resolveMarketingLocale(request)).toBe('tr')
  })

  it('should fall back to Accept-Language when there is no geo header at all', () => {
    const request = fakeRequest({ acceptLanguage: 'tr-TR,tr;q=0.9,en;q=0.8' })
    expect(resolveMarketingLocale(request)).toBe('tr')
  })

  it('should default to en when nothing matches', () => {
    const request = fakeRequest({ country: 'DE', acceptLanguage: 'fr-FR' })
    expect(resolveMarketingLocale(request)).toBe('en')
  })

  it('should default to en when no signals are present at all', () => {
    expect(resolveMarketingLocale(fakeRequest({}))).toBe('en')
  })
})
