import { describe, it, expect } from 'vitest'
import {
  appendSignatureBlock,
  resolveSignatureContext,
  type ClientSignatureContext,
  type SignatureClient,
  type CampaignSignatureOverrides,
} from './signature'

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

const client: SignatureClient = {
  name: 'Uniforms Fashion',
  signature_name: 'Client Name',
  signature_title: 'Client Title',
  phone: '+1 555 000 0000',
  address: '1 Client St',
  domain: 'uniformsfashion.com',
}

const noOverrides: CampaignSignatureOverrides = {
  signatureName: null,
  signatureTitle: null,
  phone: null,
  address: null,
}

describe('resolveSignatureContext', () => {
  it('should fall back entirely to the client when no campaign overrides are set', () => {
    expect(resolveSignatureContext(client, noOverrides)).toEqual<ClientSignatureContext>({
      companyName: 'Uniforms Fashion',
      signatureName: 'Client Name',
      signatureTitle: 'Client Title',
      phone: '+1 555 000 0000',
      address: '1 Client St',
      domain: 'uniformsfashion.com',
    })
  })

  it('should override only the phone number when just that field is set on the campaign', () => {
    const result = resolveSignatureContext(client, { ...noOverrides, phone: '+1 555 999 9999' })
    expect(result.phone).toBe('+1 555 999 9999')
    expect(result.signatureName).toBe('Client Name')
    expect(result.signatureTitle).toBe('Client Title')
    expect(result.address).toBe('1 Client St')
  })

  it('should override every field when the campaign sets all four', () => {
    const overrides: CampaignSignatureOverrides = {
      signatureName: 'Campaign Name',
      signatureTitle: 'Campaign Title',
      phone: '+1 555 111 1111',
      address: '2 Campaign Ave',
    }
    const result = resolveSignatureContext(client, overrides)
    expect(result).toEqual<ClientSignatureContext>({
      companyName: 'Uniforms Fashion',
      signatureName: 'Campaign Name',
      signatureTitle: 'Campaign Title',
      phone: '+1 555 111 1111',
      address: '2 Campaign Ave',
      domain: 'uniformsfashion.com',
    })
  })

  it('should resolve to null fields when both the client and campaign have none set', () => {
    const emptyClient: SignatureClient = {
      name: 'No Signature Co',
      signature_name: null,
      signature_title: null,
      phone: null,
      address: null,
      domain: null,
    }
    expect(resolveSignatureContext(emptyClient, noOverrides)).toEqual<ClientSignatureContext>({
      companyName: 'No Signature Co',
      signatureName: null,
      signatureTitle: null,
      phone: null,
      address: null,
      domain: null,
    })
  })

  it('should treat a null client as having no values, deferring entirely to campaign overrides', () => {
    const overrides: CampaignSignatureOverrides = {
      signatureName: 'Campaign Name',
      signatureTitle: null,
      phone: '+1 555 111 1111',
      address: null,
    }
    expect(resolveSignatureContext(null, overrides)).toEqual<ClientSignatureContext>({
      companyName: '',
      signatureName: 'Campaign Name',
      signatureTitle: null,
      phone: '+1 555 111 1111',
      address: null,
      domain: null,
    })
  })
})
