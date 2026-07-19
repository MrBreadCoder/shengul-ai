import { describe, it, expect } from 'vitest'
import { loadEnv } from './env'

const complete: Record<string, string> = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://abc.supabase.co',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key',
  SUPABASE_SERVICE_ROLE_KEY: 'service-key',
  APP_URL: 'http://localhost:3000',
  GOOGLE_OAUTH_CLIENT_ID: 'gid',
  GOOGLE_OAUTH_CLIENT_SECRET: 'gsecret',
  MICROSOFT_OAUTH_CLIENT_ID: 'mid',
  MICROSOFT_OAUTH_CLIENT_SECRET: 'msecret',
  QSTASH_TOKEN: 'qtoken',
  QSTASH_CURRENT_SIGNING_KEY: 'sig1',
  QSTASH_NEXT_SIGNING_KEY: 'sig2',
  BRIGHTDATA_API_KEY: 'bd',
  GEMINI_API_KEY: 'gem',
  EMAILABLE_API_KEY: 'em',
}

describe('loadEnv', () => {
  it('should return a typed env object when all vars are present', () => {
    const env = loadEnv(complete)
    expect(env.NEXT_PUBLIC_SUPABASE_URL).toBe('https://abc.supabase.co')
    expect(env.APP_URL).toBe('http://localhost:3000')
  })

  it('should throw CONFIG_ERROR when a required var is missing', () => {
    const { QSTASH_TOKEN: _omit, ...partial } = complete
    expect(() => loadEnv(partial)).toThrowError(/QSTASH_TOKEN/)
  })

  it('should throw CONFIG_ERROR when APP_URL is not a valid url', () => {
    expect(() => loadEnv({ ...complete, APP_URL: 'not-a-url' })).toThrowError(/APP_URL/)
  })

  it('should reject blank strings for required vars', () => {
    expect(() => loadEnv({ ...complete, GEMINI_API_KEY: '' })).toThrowError(/GEMINI_API_KEY/)
  })
})
