import { describe, it, expect } from 'vitest'
import { evaluateBounceHealth, HEALTH_REASON } from './health'

describe('evaluateBounceHealth', () => {
  it('should return null when the sample is too small to judge', () => {
    const verdict = evaluateBounceHealth({ current: 'ok', sentCount: 19, bouncedCount: 19 })
    expect(verdict).toBeNull()
  })

  it('should return null when a healthy mailbox is below the warning rate', () => {
    const verdict = evaluateBounceHealth({ current: 'ok', sentCount: 100, bouncedCount: 2 })
    expect(verdict).toBeNull()
  })

  it('should warn when the bounce rate reaches the warning threshold', () => {
    const verdict = evaluateBounceHealth({ current: 'ok', sentCount: 100, bouncedCount: 3 })
    expect(verdict).toEqual({ health: 'warning', reason: HEALTH_REASON.bounceRateElevated })
  })

  it('should block when the bounce rate reaches the block threshold', () => {
    const verdict = evaluateBounceHealth({ current: 'ok', sentCount: 100, bouncedCount: 5 })
    expect(verdict).toEqual({ health: 'blocked', reason: HEALTH_REASON.bounceRateHigh })
  })

  it('should escalate a warning mailbox to blocked when it crosses the block threshold', () => {
    const verdict = evaluateBounceHealth({ current: 'warning', sentCount: 200, bouncedCount: 20 })
    expect(verdict).toEqual({ health: 'blocked', reason: HEALTH_REASON.bounceRateHigh })
  })

  it('should recover a warning mailbox once the rate falls back below the warning threshold', () => {
    const verdict = evaluateBounceHealth({ current: 'warning', sentCount: 100, bouncedCount: 1 })
    expect(verdict).toEqual({ health: 'ok', reason: HEALTH_REASON.bounceRateNormal })
  })

  it('should never auto-recover a blocked mailbox', () => {
    const verdict = evaluateBounceHealth({ current: 'blocked', sentCount: 100, bouncedCount: 0 })
    expect(verdict).toBeNull()
  })

  it('should return null when a warning mailbox is still elevated but not blocked', () => {
    const verdict = evaluateBounceHealth({ current: 'warning', sentCount: 100, bouncedCount: 4 })
    expect(verdict).toBeNull()
  })

  it('should return null when nothing was sent in the window', () => {
    const verdict = evaluateBounceHealth({ current: 'ok', sentCount: 0, bouncedCount: 0 })
    expect(verdict).toBeNull()
  })
})
