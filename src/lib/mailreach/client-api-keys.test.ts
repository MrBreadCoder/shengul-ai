import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockEnv = vi.hoisted(() => ({
  MAILREACH_API_KEY: 'global-key' as string,
  MAILREACH_API_KEY_UNIFORMS_FASHION: undefined as string | undefined,
}))
vi.mock('@/lib/env', () => ({ env: mockEnv }))

import { resolveMailreachApiKey } from './client-api-keys'

const UNIFORMS_FASHION_CLIENT_ID = 'd99edf8f-b185-47b2-9615-1f6e43853001'
const OTHER_CLIENT_ID = 'a1a1a1a1-b2b2-4c3c-9d4d-e5e5e5e5e5e5'

describe('resolveMailreachApiKey', () => {
  beforeEach(() => {
    mockEnv.MAILREACH_API_KEY = 'global-key'
    mockEnv.MAILREACH_API_KEY_UNIFORMS_FASHION = undefined
  })

  it('should return the global key for a client other than Uniforms Fashion', () => {
    expect(resolveMailreachApiKey(OTHER_CLIENT_ID)).toBe('global-key')
  })

  it('should return the global key for Uniforms Fashion when the override is not set', () => {
    expect(resolveMailreachApiKey(UNIFORMS_FASHION_CLIENT_ID)).toBe('global-key')
  })

  it('should return the override key for Uniforms Fashion when it is set', () => {
    mockEnv.MAILREACH_API_KEY_UNIFORMS_FASHION = 'uniforms-fashion-key'
    expect(resolveMailreachApiKey(UNIFORMS_FASHION_CLIENT_ID)).toBe('uniforms-fashion-key')
  })

  it('should not leak the Uniforms Fashion override to any other client', () => {
    mockEnv.MAILREACH_API_KEY_UNIFORMS_FASHION = 'uniforms-fashion-key'
    expect(resolveMailreachApiKey(OTHER_CLIENT_ID)).toBe('global-key')
  })
})
