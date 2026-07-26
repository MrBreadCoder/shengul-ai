import { describe, it, expect } from 'vitest'
import { generateInviteToken, hashInviteToken, inviteTokenHashEquals } from './invite-token'

describe('generateInviteToken', () => {
  it('should produce a url-safe token with no characters needing escaping', () => {
    const token = generateInviteToken()
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(encodeURIComponent(token)).toBe(token)
  })

  it('should produce a different token every call', () => {
    const tokens = new Set(Array.from({ length: 100 }, () => generateInviteToken()))
    expect(tokens.size).toBe(100)
  })

  it('should carry at least 256 bits of entropy', () => {
    // base64url of 32 bytes is 43 chars once padding is dropped. A shorter
    // token would mean someone reduced TOKEN_BYTES.
    expect(generateInviteToken().length).toBeGreaterThanOrEqual(43)
  })
})

describe('hashInviteToken', () => {
  it('should return a hex sha-256 digest', () => {
    expect(hashInviteToken('abc')).toMatch(/^[0-9a-f]{64}$/)
  })

  it('should be stable for the same input', () => {
    expect(hashInviteToken('abc')).toBe(hashInviteToken('abc'))
  })

  it('should never return the raw token', () => {
    const token = generateInviteToken()
    expect(hashInviteToken(token)).not.toBe(token)
  })

  it('should differ for tokens differing by one character', () => {
    expect(hashInviteToken('token-a')).not.toBe(hashInviteToken('token-b'))
  })
})

describe('inviteTokenHashEquals', () => {
  it('should return true for identical hashes', () => {
    const hash = hashInviteToken('abc')
    expect(inviteTokenHashEquals(hash, hash)).toBe(true)
  })

  it('should return false for different hashes of the same length', () => {
    expect(inviteTokenHashEquals(hashInviteToken('a'), hashInviteToken('b'))).toBe(false)
  })

  it('should return false rather than throw on a length mismatch', () => {
    expect(inviteTokenHashEquals('abc', hashInviteToken('abc'))).toBe(false)
  })
})
