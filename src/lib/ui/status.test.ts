import { describe, it, expect } from 'vitest'
import { LEAD_EMAIL_STATUS, leadEmailStatusMetaFor } from './status'

describe('leadEmailStatusMetaFor', () => {
  it('should show the real risky label to an operator', () => {
    expect(leadEmailStatusMetaFor('risky', 'operator')).toEqual(LEAD_EMAIL_STATUS.risky)
  })

  it('should show the verified label to a client, not risky', () => {
    expect(leadEmailStatusMetaFor('risky', 'client')).toEqual(LEAD_EMAIL_STATUS.verified)
  })

  it('should show the real verified label to a client when the lead is actually verified', () => {
    expect(leadEmailStatusMetaFor('verified', 'client')).toEqual(LEAD_EMAIL_STATUS.verified)
  })

  it('should pass every other status through unchanged for both roles', () => {
    expect(leadEmailStatusMetaFor('invalid', 'operator')).toEqual(LEAD_EMAIL_STATUS.invalid)
    expect(leadEmailStatusMetaFor('invalid', 'client')).toEqual(LEAD_EMAIL_STATUS.invalid)
    expect(leadEmailStatusMetaFor('unverified', 'client')).toEqual(LEAD_EMAIL_STATUS.unverified)
    expect(leadEmailStatusMetaFor('not_found', 'client')).toEqual(LEAD_EMAIL_STATUS.not_found)
  })
})
