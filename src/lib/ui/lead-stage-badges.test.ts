import { describe, it, expect } from 'vitest'
import { buildStageBadges } from './lead-stage-badges'

describe('buildStageBadges', () => {
  it('should return an empty array when given no stages', () => {
    expect(buildStageBadges([])).toEqual([])
  })

  it('should order active stages most-positive first', () => {
    expect(buildStageBadges(['waiting', 'contacted', 'hot_handoff'])).toEqual([
      'hot_handoff', 'contacted', 'waiting',
    ])
  })

  it('should deduplicate repeated stages', () => {
    expect(buildStageBadges(['contacted', 'contacted', 'waiting'])).toEqual(['contacted', 'waiting'])
  })

  it('should suppress lost/dead when at least one contact is still active', () => {
    expect(buildStageBadges(['contacted', 'lost'])).toEqual(['contacted'])
  })

  it('should show a single lost badge once every contact is terminal and at least one is lost', () => {
    expect(buildStageBadges(['lost', 'dead'])).toEqual(['lost'])
  })

  it('should show a single dead badge when every contact is terminal and none are lost', () => {
    expect(buildStageBadges(['dead', 'dead'])).toEqual(['dead'])
  })
})
