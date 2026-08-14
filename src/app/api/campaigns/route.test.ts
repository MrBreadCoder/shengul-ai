import { describe, it, expect, vi, beforeEach } from 'vitest'

const requireUserMock = vi.fn()
const insertCampaignMock = vi.fn()
const logEventMock = vi.fn()
const getClientByIdMock = vi.fn()
const assertMailboxesBelongToClientMock = vi.fn()

vi.mock('@/lib/auth/require-user', () => ({ requireUser: (...a: unknown[]) => requireUserMock(...a) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/db/campaigns', () => ({ insertCampaign: (...a: unknown[]) => insertCampaignMock(...a) }))
vi.mock('@/lib/db/clients', () => ({ getClientById: (...a: unknown[]) => getClientByIdMock(...a) }))
vi.mock('@/lib/db/mailboxes', () => ({
  assertMailboxesBelongToClient: (...a: unknown[]) => assertMailboxesBelongToClientMock(...a),
}))
vi.mock('@/lib/events/log-event', () => ({ logEvent: (...a: unknown[]) => logEventMock(...a) }))

import { POST } from './route'
import { AppError } from '@/lib/errors/app-error'

function req(body: unknown) {
  return new Request('http://x', { method: 'POST', body: JSON.stringify(body) })
}

const validBody = {
  clientId: '11111111-1111-4111-8111-111111111111',
  name: 'Q3 campaign',
  valueProp: 'We save you time',
  mailboxIds: ['22222222-2222-4222-8222-222222222222'],
}

beforeEach(() => {
  requireUserMock.mockReset()
  insertCampaignMock.mockReset()
  logEventMock.mockReset().mockResolvedValue(undefined)
  assertMailboxesBelongToClientMock.mockReset().mockResolvedValue(undefined)
  getClientByIdMock.mockReset().mockResolvedValue({
    id: validBody.clientId,
    reply_mode: 'human_approve',
    timezone: 'UTC',
    default_discover_time: '06:00',
  })
})

describe('POST /api/campaigns', () => {
  it('should return 403 when the caller has the client role', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'client' } })
    const res = await POST(req(validBody))
    expect(res.status).toBe(403)
    expect(insertCampaignMock).not.toHaveBeenCalled()
  })

  it('should return 400 on validation error', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'operator' } })
    const res = await POST(req({ ...validBody, name: '' }))
    expect(res.status).toBe(400)
  })

  it('should create the campaign for an operator', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'operator' } })
    insertCampaignMock.mockResolvedValue({ id: 'camp1', name: 'Q3 campaign' })
    const res = await POST(req(validBody))
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json).toEqual({ ok: true, campaign: { id: 'camp1', name: 'Q3 campaign' } })
  })

  it('should pass exclude filters through into the stored ICP', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'operator' } })
    insertCampaignMock.mockResolvedValue({ id: 'camp1', name: 'Q3 campaign' })

    await POST(req({
      ...validBody,
      excludeOrganizationLocations: ['ireland'],
      excludeKeywords: ['staffing'],
    }))

    expect(insertCampaignMock).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        icp: expect.objectContaining({
          excludeOrganizationLocations: ['ireland'],
          excludeKeywords: ['staffing'],
        }),
      }),
    )
  })

  it('should use the client current reply_mode as the new campaign default', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'operator' } })
    getClientByIdMock.mockResolvedValue({
      id: validBody.clientId,
      reply_mode: 'auto_send',
      timezone: 'UTC',
      default_discover_time: '06:00',
    })
    insertCampaignMock.mockResolvedValue({ id: 'camp1', name: 'Q3 campaign' })

    await POST(req(validBody))

    expect(insertCampaignMock).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ reply_mode: 'auto_send' }),
    )
  })

  it('should return 404 when the client does not exist', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'operator' } })
    getClientByIdMock.mockResolvedValue(null)

    const res = await POST(req(validBody))

    expect(res.status).toBe(404)
    expect(insertCampaignMock).not.toHaveBeenCalled()
  })

  it('should pass personSeniorities and contactEmailStatuses through into the stored ICP', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'operator' } })
    insertCampaignMock.mockResolvedValue({ id: 'camp1', name: 'Q3 campaign' })

    await POST(req({
      ...validBody,
      personSeniorities: ['vp', 'director'],
      contactEmailStatuses: ['verified'],
    }))

    expect(insertCampaignMock).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        icp: expect.objectContaining({
          personSeniorities: ['vp', 'director'],
          contactEmailStatuses: ['verified'],
        }),
      }),
    )
  })

  it('should default personSeniorities and contactEmailStatuses to empty arrays when omitted', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'operator' } })
    insertCampaignMock.mockResolvedValue({ id: 'camp1', name: 'Q3 campaign' })

    await POST(req(validBody))

    expect(insertCampaignMock).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        icp: expect.objectContaining({ personSeniorities: [], contactEmailStatuses: [] }),
      }),
    )
  })

  it('should reject an unrecognized seniority value with a 400', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'operator' } })

    const res = await POST(req({ ...validBody, personSeniorities: ['not_a_real_seniority'] }))

    expect(res.status).toBe(400)
    expect(insertCampaignMock).not.toHaveBeenCalled()
  })

  it('should compute next_discover_at from the client default when no override is given', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'operator' } })
    getClientByIdMock.mockResolvedValue({
      id: validBody.clientId,
      reply_mode: 'human_approve',
      timezone: 'UTC',
      default_discover_time: '06:00',
    })
    insertCampaignMock.mockResolvedValue({ id: 'camp1', name: 'Q3 campaign' })

    await POST(req(validBody))

    expect(insertCampaignMock).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ discover_time: null, discover_timezone: null, next_discover_at: expect.any(String) }),
    )
  })

  it('should return 400 when no mailbox is selected', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'operator' } })

    const res = await POST(req({ ...validBody, mailboxIds: [] }))

    expect(res.status).toBe(400)
    expect(insertCampaignMock).not.toHaveBeenCalled()
  })

  it('should pass mailboxIds through as mailbox_ids on the inserted row', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'operator' } })
    insertCampaignMock.mockResolvedValue({ id: 'camp1', name: 'Q3 campaign' })

    await POST(req(validBody))

    expect(assertMailboxesBelongToClientMock).toHaveBeenCalledWith({}, validBody.clientId, validBody.mailboxIds)
    expect(insertCampaignMock).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ mailbox_ids: validBody.mailboxIds }),
    )
  })

  it('should return 400 when a selected mailbox does not belong to the client', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'operator' } })
    assertMailboxesBelongToClientMock.mockRejectedValue(
      new AppError('VALIDATION_ERROR', 'One of the selected mailboxes does not belong to this client'),
    )

    const res = await POST(req(validBody))

    expect(res.status).toBe(400)
    expect(insertCampaignMock).not.toHaveBeenCalled()
  })

  it("should store the campaign's own discoverTime/discoverTimezone override", async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'operator' } })
    getClientByIdMock.mockResolvedValue({
      id: validBody.clientId,
      reply_mode: 'human_approve',
      timezone: 'UTC',
      default_discover_time: '06:00',
    })
    insertCampaignMock.mockResolvedValue({ id: 'camp1', name: 'Q3 campaign' })

    await POST(req({ ...validBody, discoverTime: '09:00', discoverTimezone: 'Europe/Istanbul' }))

    expect(insertCampaignMock).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ discover_time: '09:00', discover_timezone: 'Europe/Istanbul' }),
    )
  })

  it('should default the signature override fields to null when omitted', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'operator' } })
    getClientByIdMock.mockResolvedValue({
      id: validBody.clientId,
      reply_mode: 'human_approve',
      timezone: 'UTC',
      default_discover_time: '06:00',
    })
    insertCampaignMock.mockResolvedValue({ id: 'camp1', name: 'Q3 campaign' })

    await POST(req(validBody))

    expect(insertCampaignMock).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ signature_name: null, signature_title: null, phone: null, address: null }),
    )
  })

  it("should store the campaign's own signature override fields", async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'operator' } })
    getClientByIdMock.mockResolvedValue({
      id: validBody.clientId,
      reply_mode: 'human_approve',
      timezone: 'UTC',
      default_discover_time: '06:00',
    })
    insertCampaignMock.mockResolvedValue({ id: 'camp1', name: 'Q3 campaign' })

    await POST(
      req({
        ...validBody,
        signatureName: 'John Smith',
        signatureTitle: 'Sales Director',
        phone: '+1 555 123 4567',
        address: '123 Main St',
      }),
    )

    expect(insertCampaignMock).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        signature_name: 'John Smith',
        signature_title: 'Sales Director',
        phone: '+1 555 123 4567',
        address: '123 Main St',
      }),
    )
  })
})
