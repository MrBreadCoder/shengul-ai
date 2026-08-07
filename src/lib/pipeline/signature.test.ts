import { describe, it, expect } from 'vitest'
import { appendSignatureBlock, type ClientSignatureContext } from './signature'

const base: ClientSignatureContext = {
  companyName: 'Uniforms Fashion',
  signatureName: null,
  signatureTitle: null,
  phone: null,
  address: null,
  domain: null,
}

describe('appendSignatureBlock', () => {
  it('should return the body unchanged when phone is null, even with address set', () => {
    expect(appendSignatureBlock('Hi Jane...', { ...base, address: '123 Main St' })).toBe('Hi Jane...')
  })

  it('should append a minimal block with just company name and phone', () => {
    const result = appendSignatureBlock('Hi Jane...', { ...base, phone: '+1 555 123 4567' })
    expect(result).toBe('Hi Jane...\n\nBest regards,\n\nUniforms Fashion\n\n+1 555 123 4567')
  })

  it('should append every field when all are set', () => {
    const result = appendSignatureBlock('Hi Jane...', {
      companyName: 'Uniforms Fashion',
      signatureName: 'John Smith',
      signatureTitle: 'Sales Director',
      phone: '+1 (505) 555-1234',
      address: '123 Main St, Istanbul, Turkey',
      domain: 'uniformsfashion.com',
    })
    expect(result).toBe(
      'Hi Jane...\n\nBest regards,\n\nJohn Smith\nSales Director\nUniforms Fashion\n\n' +
        '+1 (505) 555-1234\n123 Main St, Istanbul, Turkey\nuniformsfashion.com',
    )
  })

  it('should omit signatureTitle when only signatureName is set', () => {
    const result = appendSignatureBlock('Hi.', { ...base, phone: '+1 5551234567', signatureName: 'John Smith' })
    expect(result).toBe('Hi.\n\nBest regards,\n\nJohn Smith\nUniforms Fashion\n\n+1 5551234567')
  })

  it('should omit address and domain when neither is set', () => {
    const result = appendSignatureBlock('Hi.', { ...base, phone: '+1 5551234567' })
    expect(result).not.toContain('\nnull')
    expect(result.endsWith('+1 5551234567')).toBe(true)
  })
})
