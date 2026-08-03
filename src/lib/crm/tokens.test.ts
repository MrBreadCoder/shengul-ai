import { describe, it, expect } from 'vitest'
import { encryptCrmTokens, parseCrmTokens, type CrmOAuthCredentials } from './tokens'
import { AppError } from '@/lib/errors/app-error'

// Long, distinctive values so a substring check against the ciphertext cannot
// coincidentally pass.
const tokens: CrmOAuthCredentials = {
  kind: 'oauth',
  accessToken: 'hubspot-access-token-fixture-qzptv',
  refreshToken: 'hubspot-refresh-token-fixture-mwbkr',
  expiresAt: '2099-01-01T00:00:00.000Z',
}

describe('encryptCrmTokens', () => {
  it('should produce a versioned ciphertext blob rather than the plaintext tokens', () => {
    const encrypted = encryptCrmTokens(tokens)

    expect(encrypted).toMatchObject({ v: 1 })
    expect(JSON.stringify(encrypted)).not.toContain('access-token-fixture')
    expect(JSON.stringify(encrypted)).not.toContain('refresh-token-fixture')
  })

  it('should produce a different ciphertext each call when given identical input', () => {
    const a = encryptCrmTokens(tokens)
    const b = encryptCrmTokens(tokens)

    expect(a.data).not.toEqual(b.data)
    expect(a.iv).not.toEqual(b.iv)
  })
})

describe('parseCrmTokens', () => {
  it('should round-trip the credentials when given its own ciphertext', () => {
    const parsed = parseCrmTokens(encryptCrmTokens(tokens), 'conn-1')

    expect(parsed).toEqual(tokens)
  })

  it('should throw INVARIANT_VIOLATION when the ciphertext was tampered with', () => {
    const encrypted = encryptCrmTokens(tokens)
    const tampered = { ...encrypted, data: Buffer.from('not-the-real-ciphertext').toString('base64') }

    expect(() => parseCrmTokens(tampered, 'conn-1')).toThrow(AppError)
  })

  it('should throw INVARIANT_VIOLATION when the auth tag was tampered with', () => {
    const encrypted = encryptCrmTokens(tokens)
    const tampered = { ...encrypted, tag: Buffer.alloc(16).toString('base64') }

    expect(() => parseCrmTokens(tampered, 'conn-1')).toThrow(AppError)
  })

  it('should reject plaintext credentials, which must never be stored', () => {
    expect(() => parseCrmTokens(tokens as never, 'conn-1')).toThrow(AppError)
  })

  it('should throw INVARIANT_VIOLATION when the column is the empty default', () => {
    expect(() => parseCrmTokens({}, 'conn-1')).toThrow(AppError)
  })
})
