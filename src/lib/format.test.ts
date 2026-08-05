import { describe, it, expect } from 'vitest'
import { formatFollowupCountdown, formatFollowupStatus } from './format'

const NOW = new Date('2026-08-05T12:00:00.000Z')

describe('formatFollowupCountdown', () => {
  it('should return null when there is nothing scheduled', () => {
    expect(formatFollowupCountdown(null, NOW)).toBeNull()
  })

  it('should round up to the next whole day', () => {
    const in36Hours = new Date(NOW.getTime() + 36 * 60 * 60 * 1000).toISOString()
    expect(formatFollowupCountdown(in36Hours, NOW)).toBe('2d')
  })

  it('should return "today" for a timestamp in the past or present', () => {
    const anHourAgo = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString()
    expect(formatFollowupCountdown(anHourAgo, NOW)).toBe('today')
    expect(formatFollowupCountdown(NOW.toISOString(), NOW)).toBe('today')
  })

  it('should return null for an unparseable timestamp', () => {
    expect(formatFollowupCountdown('not-a-date', NOW)).toBeNull()
  })
})

describe('formatFollowupStatus', () => {
  it('should include the countdown clause when one is given', () => {
    expect(formatFollowupStatus(1, 3, '3d')).toBe('1/3 follow-ups sent · next in 3d')
  })

  it('should omit the countdown clause when null', () => {
    expect(formatFollowupStatus(3, 3, null)).toBe('3/3 follow-ups sent')
  })

  it('should use the singular "follow-up" for a one-step cadence', () => {
    expect(formatFollowupStatus(0, 1, '5d')).toBe('0/1 follow-up sent · next in 5d')
  })
})
