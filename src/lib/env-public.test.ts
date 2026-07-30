import { describe, it, expect } from 'vitest'
import { loadPublicEnv } from './env-public'

const complete: Record<string, string> = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://abc.supabase.co',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key',
}

describe('loadPublicEnv', () => {
  it('should return a typed public env object when all vars are present', () => {
    const publicEnv = loadPublicEnv(complete)
    expect(publicEnv.NEXT_PUBLIC_SUPABASE_URL).toBe('https://abc.supabase.co')
    expect(publicEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY).toBe('anon-key')
  })

  it('should ignore server-only vars so no secret can be read through it', () => {
    const publicEnv = loadPublicEnv({ ...complete, SUPABASE_SERVICE_ROLE_KEY: 'service-key' })
    expect(publicEnv).not.toHaveProperty('SUPABASE_SERVICE_ROLE_KEY')
  })

  it('should throw CONFIG_ERROR when a required var is missing', () => {
    const { NEXT_PUBLIC_SUPABASE_ANON_KEY: _omit, ...partial } = complete
    expect(() => loadPublicEnv(partial)).toThrowError(/NEXT_PUBLIC_SUPABASE_ANON_KEY/)
  })

  it('should throw CONFIG_ERROR when the supabase url is not a valid url', () => {
    expect(() => loadPublicEnv({ ...complete, NEXT_PUBLIC_SUPABASE_URL: 'not-a-url' })).toThrowError(
      /NEXT_PUBLIC_SUPABASE_URL/,
    )
  })

  it('should reject blank strings for required vars', () => {
    expect(() => loadPublicEnv({ ...complete, NEXT_PUBLIC_SUPABASE_ANON_KEY: '' })).toThrowError(
      /NEXT_PUBLIC_SUPABASE_ANON_KEY/,
    )
  })

  it('should allow NEXT_PUBLIC_GTM_ID to be omitted', () => {
    const publicEnv = loadPublicEnv(complete)
    expect(publicEnv.NEXT_PUBLIC_GTM_ID).toBeUndefined()
  })

  it('should accept a well-formed NEXT_PUBLIC_GTM_ID', () => {
    const publicEnv = loadPublicEnv({ ...complete, NEXT_PUBLIC_GTM_ID: 'GTM-T8WVXHJQ' })
    expect(publicEnv.NEXT_PUBLIC_GTM_ID).toBe('GTM-T8WVXHJQ')
  })

  it('should throw CONFIG_ERROR when NEXT_PUBLIC_GTM_ID is malformed', () => {
    expect(() => loadPublicEnv({ ...complete, NEXT_PUBLIC_GTM_ID: 'not-a-gtm-id' })).toThrowError(
      /NEXT_PUBLIC_GTM_ID/,
    )
  })

  it('should allow the search-verification vars to be omitted', () => {
    const publicEnv = loadPublicEnv(complete)
    expect(publicEnv.NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION).toBeUndefined()
    expect(publicEnv.NEXT_PUBLIC_BING_SITE_VERIFICATION).toBeUndefined()
  })

  it('should accept search-verification vars when present', () => {
    const publicEnv = loadPublicEnv({
      ...complete,
      NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION: 'google-token',
      NEXT_PUBLIC_BING_SITE_VERIFICATION: 'bing-token',
    })
    expect(publicEnv.NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION).toBe('google-token')
    expect(publicEnv.NEXT_PUBLIC_BING_SITE_VERIFICATION).toBe('bing-token')
  })

  it('should reject a blank NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION', () => {
    expect(() =>
      loadPublicEnv({ ...complete, NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION: '' }),
    ).toThrowError(/NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION/)
  })
})
