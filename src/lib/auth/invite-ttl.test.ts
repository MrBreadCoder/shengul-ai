import { describe, it, expect } from 'vitest'
import { inviteExpiryFrom, formatInviteTtl, INVITE_TTL_MINUTES } from './invite-ttl'

describe('inviteExpiryFrom', () => {
  it('should expire two hours after the given time', () => {
    const now = new Date('2026-07-26T12:00:00.000Z')
    expect(INVITE_TTL_MINUTES).toBe(120)
    expect(inviteExpiryFrom(now).toISOString()).toBe('2026-07-26T14:00:00.000Z')
  })

  it('should carry the expiry across a day boundary', () => {
    const now = new Date('2026-07-26T23:30:00.000Z')
    expect(inviteExpiryFrom(now).toISOString()).toBe('2026-07-27T01:30:00.000Z')
  })

  it('should not mutate the date it is given', () => {
    const now = new Date('2026-07-26T12:00:00.000Z')
    inviteExpiryFrom(now)
    expect(now.toISOString()).toBe('2026-07-26T12:00:00.000Z')
  })
})

describe('formatInviteTtl', () => {
  it('should describe the configured window in hours', () => {
    expect(formatInviteTtl(INVITE_TTL_MINUTES)).toBe('2 hours')
  })

  it('should singularise a one-hour window', () => {
    expect(formatInviteTtl(60)).toBe('1 hour')
  })

  it('should fall back to minutes when the window is not a whole number of hours', () => {
    expect(formatInviteTtl(90)).toBe('90 minutes')
    expect(formatInviteTtl(5)).toBe('5 minutes')
    expect(formatInviteTtl(1)).toBe('1 minute')
  })
})
