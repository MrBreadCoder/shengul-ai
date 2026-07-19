import { describe, it, expect } from 'vitest'
import { getMailboxProvider } from './registry'

describe('getMailboxProvider', () => {
  it('should return the gmail provider when asked for gmail', () => {
    expect(getMailboxProvider('gmail').provider).toBe('gmail')
  })
  it('should return the outlook provider when asked for outlook', () => {
    expect(getMailboxProvider('outlook').provider).toBe('outlook')
  })
})
