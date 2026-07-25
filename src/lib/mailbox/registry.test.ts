import { describe, it, expect } from 'vitest'
import { getMailboxProvider } from './registry'

describe('getMailboxProvider', () => {
  it.each(['gmail', 'outlook', 'smtp'] as const)(
    'should resolve a provider whose name matches when given %s',
    (name) => {
      expect(getMailboxProvider(name).provider).toBe(name)
    },
  )

  it('should throw for an unknown provider rather than returning undefined', () => {
    // Cast is the point of the test: it simulates a DB row whose provider
    // column outran the registry.
    expect(() => getMailboxProvider('carrier-pigeon' as never)).toThrow()
  })
})
