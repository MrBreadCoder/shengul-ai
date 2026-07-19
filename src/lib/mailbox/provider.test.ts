import { describe, it, expect } from 'vitest'
import type { MailboxProvider } from './provider'

// A compile-and-shape guard: a conforming object satisfies the interface.
describe('MailboxProvider contract', () => {
  it('should accept a conforming implementation shape', () => {
    const fake: MailboxProvider = {
      provider: 'gmail',
      buildAuthUrl: (state) => `https://auth?state=${state}`,
      exchangeCode: async () => ({
        tokens: { accessToken: 'a', refreshToken: 'r', expiresAt: '2026-01-01T00:00:00Z' },
        emailAddress: 'x@y.com',
        displayName: null,
      }),
      sendEmail: async (tokens) => ({
        result: { providerMessageId: 'm', threadId: 't' },
        tokens,
      }),
    }
    expect(fake.provider).toBe('gmail')
    expect(fake.buildAuthUrl('s')).toContain('state=s')
  })
})
