import { describe, it, expect, vi, beforeEach } from 'vitest'

const requireUser = vi.fn()
const getClientById = vi.fn()
const updateClientMailreachEnabled = vi.fn()
const bulkDisconnectForClient = vi.fn()
const bulkReconnectSmtpForClient = vi.fn()
const logEvent = vi.fn()
const logEventSafe = vi.fn()
const revalidatePath = vi.fn()

vi.mock('@/lib/auth/require-user', () => ({ requireUser: (...a: unknown[]) => requireUser(...a) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/db/clients', () => ({
  getClientById: (...a: unknown[]) => getClientById(...a),
  updateClientMailreachEnabled: (...a: unknown[]) => updateClientMailreachEnabled(...a),
}))
vi.mock('@/lib/mailreach/enrollment', () => ({
  bulkDisconnectForClient: (...a: unknown[]) => bulkDisconnectForClient(...a),
  bulkReconnectSmtpForClient: (...a: unknown[]) => bulkReconnectSmtpForClient(...a),
}))
vi.mock('@/lib/events/log-event', () => ({
  logEvent: (...a: unknown[]) => logEvent(...a),
  logEventSafe: (...a: unknown[]) => logEventSafe(...a),
}))
vi.mock('next/cache', () => ({ revalidatePath: (...a: unknown[]) => revalidatePath(...a) }))

const { setClientMailreachEnabled } = await import('./mailreach-actions')

beforeEach(() => {
  vi.clearAllMocks()
  requireUser.mockResolvedValue({ appUser: { id: 'op1', role: 'operator' } })
  getClientById.mockResolvedValue({ id: 'c1', name: 'Acme', mailreach_enabled: true })
  updateClientMailreachEnabled.mockResolvedValue({ id: 'c1', name: 'Acme', mailreach_enabled: false })
})

describe('setClientMailreachEnabled', () => {
  it('should bulk-disconnect when turned off', async () => {
    bulkDisconnectForClient.mockResolvedValue({ attempted: 2, succeeded: 2, failed: 0 })
    const result = await setClientMailreachEnabled('c1', false)
    expect(result).toEqual({ ok: true })
    expect(bulkDisconnectForClient).toHaveBeenCalledWith(expect.anything(), 'c1')
    expect(bulkReconnectSmtpForClient).not.toHaveBeenCalled()
    expect(logEvent).toHaveBeenCalledWith(expect.objectContaining({ clientId: 'c1', type: 'client.mailreach_enabled_changed' }))
    expect(revalidatePath).toHaveBeenCalledWith('/clients/c1')
  })

  it('should bulk-reconnect smtp mailboxes when turned on', async () => {
    getClientById.mockResolvedValue({ id: 'c1', name: 'Acme', mailreach_enabled: false })
    bulkReconnectSmtpForClient.mockResolvedValue({ attempted: 1, succeeded: 1, failed: 0 })
    const result = await setClientMailreachEnabled('c1', true)
    expect(result).toEqual({ ok: true })
    expect(bulkReconnectSmtpForClient).toHaveBeenCalledWith(expect.anything(), 'c1', expect.any(Date))
    expect(bulkDisconnectForClient).not.toHaveBeenCalled()
  })

  it('should reject a client-role user', async () => {
    requireUser.mockResolvedValue({ appUser: { id: 'u2', role: 'client' } })
    const result = await setClientMailreachEnabled('c1', true)
    expect(result).toEqual({ ok: false, code: 'UNAUTHORIZED' })
    expect(updateClientMailreachEnabled).not.toHaveBeenCalled()
  })

  it('should reject an unknown client', async () => {
    getClientById.mockResolvedValue(null)
    const result = await setClientMailreachEnabled('missing', true)
    expect(result).toEqual({ ok: false, code: 'NOT_FOUND' })
  })

  it('should still succeed when the bulk reconnect throws', async () => {
    getClientById.mockResolvedValue({ id: 'c1', name: 'Acme', mailreach_enabled: false })
    bulkReconnectSmtpForClient.mockRejectedValue(new Error('mailreach api down'))
    const result = await setClientMailreachEnabled('c1', true)
    expect(result).toEqual({ ok: true })
    expect(logEventSafe).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: 'c1', type: 'client.mailreach_bulk_op_failed' }),
    )
    expect(logEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'client.mailreach_enabled_changed' }),
    )
    expect(revalidatePath).toHaveBeenCalledWith('/clients/c1')
  })
})
