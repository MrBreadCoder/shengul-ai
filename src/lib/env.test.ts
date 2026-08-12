import { describe, it, expect, vi } from 'vitest'
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
  MAILBOX_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  QSTASH_TOKEN: 'qtoken',
  QSTASH_CURRENT_SIGNING_KEY: 'sig1',
  QSTASH_NEXT_SIGNING_KEY: 'sig2',
  BRIGHTDATA_API_KEY: 'bd',
  BRIGHTDATA_SCRAPE_ZONE: 'web_unlocker',
  BRIGHTDATA_SERP_ZONE: 'serp_api',
  GEMINI_API_KEY: 'gem',
  APOLLO_API_KEY: 'apollo-key',
  EMAILABLE_API_KEY: 'emailable-key',
  MAILREACH_API_KEY: 'mailreach-key',
  HUBSPOT_OAUTH_CLIENT_ID: 'hs-id',
  HUBSPOT_OAUTH_CLIENT_SECRET: 'hs-secret',
  PIPEDRIVE_OAUTH_CLIENT_ID: 'pd-id',
  PIPEDRIVE_OAUTH_CLIENT_SECRET: 'pd-secret',
  REPORTS_SMTP_HOST: 'smtp.shengulai.com',
  REPORTS_SMTP_PORT: '587',
  REPORTS_SMTP_SECURE: 'false',
  REPORTS_SMTP_USERNAME: 'shengul@shengulai.com',
  REPORTS_SMTP_PASSWORD: 'app-password',
  REPORTS_FROM_EMAIL: 'shengul@shengulai.com',
  REPORTS_FROM_NAME: 'Shengul Yavuz',
}

describe('loadEnv', () => {
  it('should return a typed env object when all vars are present', () => {
    const env = loadEnv(complete)
    expect(env.NEXT_PUBLIC_SUPABASE_URL).toBe('https://abc.supabase.co')
    expect(env.APP_URL).toBe('http://localhost:3000')
    expect(env.APOLLO_API_KEY).toBe('apollo-key')
  })

  it('should throw CONFIG_ERROR when a required var is missing', () => {
    const { QSTASH_TOKEN: _omit, ...partial } = complete
    expect(() => loadEnv(partial)).toThrowError(/QSTASH_TOKEN/)
  })

  it('should throw CONFIG_ERROR when APP_URL is not a valid url', () => {
    expect(() => loadEnv({ ...complete, APP_URL: 'not-a-url' })).toThrowError(/APP_URL/)
  })

  it('should reject blank strings for required vars', () => {
    expect(() => loadEnv({ ...complete, APOLLO_API_KEY: '' })).toThrowError(/APOLLO_API_KEY/)
  })

  it('should require EMAILABLE_API_KEY', () => {
    const { EMAILABLE_API_KEY: _omit, ...partial } = complete
    expect(() => loadEnv(partial)).toThrowError(/EMAILABLE_API_KEY/)
    expect(() => loadEnv({ ...complete, EMAILABLE_API_KEY: '' })).toThrowError(/EMAILABLE_API_KEY/)
  })

  it('should reject a MAILBOX_ENCRYPTION_KEY that is not a 64-character hex string', () => {
    expect(() => loadEnv({ ...complete, MAILBOX_ENCRYPTION_KEY: 'too-short' })).toThrowError(/MAILBOX_ENCRYPTION_KEY/)
  })

  it('should leave MAILREACH_API_KEY_UNIFORMS_FASHION undefined when unset', () => {
    const env = loadEnv(complete)
    expect(env.MAILREACH_API_KEY_UNIFORMS_FASHION).toBeUndefined()
  })

  it('should accept MAILREACH_API_KEY_UNIFORMS_FASHION when set', () => {
    const env = loadEnv({ ...complete, MAILREACH_API_KEY_UNIFORMS_FASHION: 'uniforms-fashion-key' })
    expect(env.MAILREACH_API_KEY_UNIFORMS_FASHION).toBe('uniforms-fashion-key')
  })

  it('should refuse to initialise when imported into a client bundle', async () => {
    vi.stubGlobal('window', {})
    vi.resetModules()
    try {
      await expect(import('./env')).rejects.toThrowError(/server-only/)
    } finally {
      vi.unstubAllGlobals()
      vi.resetModules()
    }
  })
})
