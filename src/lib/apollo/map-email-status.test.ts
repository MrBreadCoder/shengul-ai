import { describe, it, expect } from 'vitest'
import { mapApolloEmailStatus } from './map-email-status'

describe('mapApolloEmailStatus', () => {
  it('should map "verified" to verified', () => {
    expect(mapApolloEmailStatus('verified')).toBe('verified')
  })

  it('should be case-insensitive', () => {
    expect(mapApolloEmailStatus('Verified')).toBe('verified')
  })

  it('should map "catch_all" (and "Catch-all" spelling) to risky', () => {
    expect(mapApolloEmailStatus('catch_all')).toBe('risky')
    expect(mapApolloEmailStatus('Catch-all')).toBe('risky')
  })

  it('should map "unverified" to unverified', () => {
    expect(mapApolloEmailStatus('unverified')).toBe('unverified')
  })

  it('should map "update_required" (and "Update required" spelling) to unverified', () => {
    expect(mapApolloEmailStatus('update_required')).toBe('unverified')
    expect(mapApolloEmailStatus('Update required')).toBe('unverified')
  })

  it('should map "unavailable" to not_found', () => {
    expect(mapApolloEmailStatus('unavailable')).toBe('not_found')
  })

  it('should map null or undefined to not_found', () => {
    expect(mapApolloEmailStatus(null)).toBe('not_found')
    expect(mapApolloEmailStatus(undefined)).toBe('not_found')
  })

  it('should default any unrecognized status to unverified (never guess verified)', () => {
    expect(mapApolloEmailStatus('some_new_apollo_status')).toBe('unverified')
  })
})
