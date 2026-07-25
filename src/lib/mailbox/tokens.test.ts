import { describe, it, expect } from 'vitest'
import { encryptMailboxTokens, parseMailboxTokens } from './tokens'
import { AppError } from '@/lib/errors/app-error'

// Long, distinctive values (not short strings like 'at'/'rt') so a substring
// check against the ciphertext can't coincidentally pass by chance.
const tokens = {
  accessToken: 'ya29-access-token-fixture-zzqpx',
  refreshToken: '1//refresh-token-fixture-wkbmv',
  expiresAt: '2099-01-01T00:00:00.000Z',
}

describe('encryptMailboxTokens', () => {
  it('should produce a versioned ciphertext blob, not the plaintext tokens', () => {
    const encrypted = encryptMailboxTokens(tokens as never)
    expect(encrypted).toMatchObject({ v: 1 })
    expect(typeof encrypted.iv).toBe('string')
    expect(typeof encrypted.tag).toBe('string')
    expect(typeof encrypted.data).toBe('string')
    expect(JSON.stringify(encrypted)).not.toContain('access-token-fixture')
    expect(JSON.stringify(encrypted)).not.toContain('refresh-token-fixture')
  })

  it('should produce a different ciphertext each call (random iv)', () => {
    const a = encryptMailboxTokens(tokens as never)
    const b = encryptMailboxTokens(tokens as never)
    expect(a.data).not.toEqual(b.data)
    expect(a.iv).not.toEqual(b.iv)
  })
})

describe('parseMailboxTokens', () => {
  it('should round-trip tokens through encrypt then parse', () => {
    const encrypted = encryptMailboxTokens(tokens as never)
    const result = parseMailboxTokens(encrypted, 'm1')
    expect(result).toEqual({ kind: 'oauth', ...tokens })
  })

  it('should accept legacy plaintext tokens for backward compatibility', () => {
    const result = parseMailboxTokens(tokens, 'm1')
    expect(result).toEqual({ kind: 'oauth', ...tokens })
  })

  it('should throw INVARIANT_VIOLATION for malformed oauth data', () => {
    expect(() => parseMailboxTokens({ nonsense: true }, 'm1')).toThrow(AppError)
  })

  it('should throw INVARIANT_VIOLATION when the ciphertext has been tampered with', () => {
    const encrypted = encryptMailboxTokens(tokens as never)
    const tampered = { ...encrypted, data: Buffer.from('not the real ciphertext').toString('base64') }
    expect(() => parseMailboxTokens(tampered, 'm1')).toThrow(AppError)
  })
})

const smtpCredentials = {
  kind: 'smtp' as const,
  emailAddress: 'ops@client.com',
  username: 'ops@client.com',
  password: 'smtp-password-fixture-qhvnz',
  smtpHost: 'smtp.client.com',
  smtpPort: 587,
  smtpSecure: false,
  imapHost: 'imap.client.com',
  imapPort: 993,
  imapSecure: true,
}

describe('encryptMailboxTokens with smtp credentials', () => {
  it('should never expose the password in the ciphertext blob', () => {
    const encrypted = encryptMailboxTokens(smtpCredentials)
    expect(JSON.stringify(encrypted)).not.toContain('smtp-password-fixture')
    expect(JSON.stringify(encrypted)).not.toContain('imap.client.com')
  })
})

describe('parseMailboxTokens credential shapes', () => {
  it('should round-trip smtp credentials through encrypt then parse', () => {
    const encrypted = encryptMailboxTokens(smtpCredentials)
    expect(parseMailboxTokens(encrypted, 'm1')).toEqual(smtpCredentials)
  })

  it('should round-trip tagged oauth credentials through encrypt then parse', () => {
    const tagged = { kind: 'oauth' as const, ...tokens }
    const encrypted = encryptMailboxTokens(tagged)
    expect(parseMailboxTokens(encrypted, 'm1')).toEqual(tagged)
  })

  it('should normalize legacy untagged plaintext tokens to kind oauth', () => {
    expect(parseMailboxTokens(tokens, 'm1')).toEqual({ kind: 'oauth', ...tokens })
  })

  it('should normalize legacy untagged encrypted tokens to kind oauth', () => {
    // Encrypt the untagged shape directly to simulate a row written before the
    // discriminator existed — the common case for already-connected mailboxes.
    const encrypted = encryptMailboxTokens(tokens as never)
    expect(parseMailboxTokens(encrypted, 'm1')).toEqual({ kind: 'oauth', ...tokens })
  })

  it('should throw INVARIANT_VIOLATION when smtp credentials are missing a field', () => {
    const { imapHost: _omitted, ...incomplete } = smtpCredentials
    expect(() => parseMailboxTokens(incomplete, 'm1')).toThrow(AppError)
  })
})
