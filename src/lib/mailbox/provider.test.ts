import { describe, it, expect } from 'vitest'
import { AppError } from '@/lib/errors/app-error'
import {
  requireOAuthCredentials,
  requireSmtpCredentials,
  type MailboxProvider,
  type OAuthMailboxProvider,
  type SmtpCredentials,
} from './provider'

const smtpCredentials: SmtpCredentials = {
  kind: 'smtp',
  emailAddress: 'ops@client.com',
  username: 'ops@client.com',
  password: 'pw',
  smtpHost: 'smtp.client.com',
  smtpPort: 587,
  smtpSecure: false,
  imapHost: 'imap.client.com',
  imapPort: 993,
  imapSecure: true,
}

// A compile-and-shape guard: a conforming object satisfies the interface.
describe('MailboxProvider contract', () => {
  it('should accept a password-authenticated implementation with no OAuth methods', () => {
    const fake: MailboxProvider = {
      provider: 'smtp',
      sendEmail: async (credentials) => ({
        result: { providerMessageId: 'm', threadId: 't' },
        tokens: credentials,
      }),
      fetchInbound: async (credentials) => ({
        result: { messages: [], cursor: 'c1' },
        tokens: credentials,
      }),
    }
    expect(fake.provider).toBe('smtp')
  })

  it('should accept an OAuth implementation through OAuthMailboxProvider', () => {
    const fake: OAuthMailboxProvider = {
      provider: 'gmail',
      buildAuthUrl: (state) => `https://auth?state=${state}`,
      exchangeCode: async () => ({
        tokens: { kind: 'oauth', accessToken: 'a', refreshToken: 'r', expiresAt: '2026-01-01T00:00:00Z' },
        emailAddress: 'x@y.com',
        displayName: null,
      }),
      sendEmail: async (credentials) => ({
        result: { providerMessageId: 'm', threadId: 't' },
        tokens: credentials,
      }),
      fetchInbound: async (credentials) => ({
        result: { messages: [], cursor: 'c1' },
        tokens: credentials,
      }),
    }
    expect(fake.buildAuthUrl('s')).toContain('state=s')
  })
})

describe('requireOAuthCredentials', () => {
  it('should return the credentials unchanged when the kind is oauth', () => {
    const oauth = { kind: 'oauth', accessToken: 'a', refreshToken: 'r', expiresAt: 'z' } as const
    expect(requireOAuthCredentials(oauth, 'gmail')).toBe(oauth)
  })

  it('should throw INVARIANT_VIOLATION when given smtp credentials', () => {
    try {
      requireOAuthCredentials(smtpCredentials, 'gmail')
      expect.unreachable('expected requireOAuthCredentials to throw')
    } catch (error) {
      expect((error as AppError).code).toBe('INVARIANT_VIOLATION')
    }
  })

  it('should not leak the password into the error context', () => {
    try {
      requireOAuthCredentials(smtpCredentials, 'gmail')
      expect.unreachable('expected requireOAuthCredentials to throw')
    } catch (error) {
      expect(JSON.stringify((error as AppError).context)).not.toContain('pw')
    }
  })
})

describe('requireSmtpCredentials', () => {
  it('should return the credentials unchanged when the kind is smtp', () => {
    expect(requireSmtpCredentials(smtpCredentials, 'smtp')).toBe(smtpCredentials)
  })

  it('should throw INVARIANT_VIOLATION when given oauth credentials', () => {
    const oauth = { kind: 'oauth', accessToken: 'a', refreshToken: 'r', expiresAt: 'z' } as const
    expect(() => requireSmtpCredentials(oauth, 'smtp')).toThrow(AppError)
  })
})
