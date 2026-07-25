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
})
