import { describe, it, expect } from 'vitest'
import { getCrmProvider } from './registry'

describe('getCrmProvider', () => {
  it('should return the HubSpot implementation when asked for hubspot', () => {
    expect(getCrmProvider('hubspot').provider).toBe('hubspot')
  })

  it('should return the Pipedrive implementation when asked for pipedrive', () => {
    expect(getCrmProvider('pipedrive').provider).toBe('pipedrive')
  })

  it('should throw when given a provider outside the enum', () => {
    expect(() => getCrmProvider('salesforce' as never)).toThrow()
  })
})
