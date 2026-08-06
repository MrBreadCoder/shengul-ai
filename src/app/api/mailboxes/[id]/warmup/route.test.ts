import { describe, it, expect, vi, beforeEach } from 'vitest'

const requireUser = vi.fn()
const getMailboxById = vi.fn()
const updateMailboxWarmup = vi.fn()

vi.mock('@/lib/auth/require-user', () => ({ requireUser: () => requireUser() }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/db/mailboxes', () => ({
  getMailboxById: (...args: unknown[]) => getMailboxById(...args),
  updateMailboxWarmup: (...args: unknown[]) => updateMailboxWarmup(...args),
}))
vi.mock('@/lib/events/log-event', () => ({ logEventSafe: () => Promise.resolve() }))

const { POST } = await import('./route')

const context = { params: Promise.resolve({ id: 'm1' }) }

function req(body: unknown) {
  return new Request('http://x/api/mailboxes/m1/warmup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  requireUser.mockResolvedValue({ appUser: { id: 'u1', role: 'operator' } })
  getMailboxById.mockResolvedValue({
    id: 'm1', client_id: 'c1', warmup_profile: 'standard',
    warmup_start_cap: 5, warmup_increment: 3, warmup_target_cap: 40, daily_cap: 40,
  })
  updateMailboxWarmup.mockResolvedValue(undefined)
})

describe('POST /api/mailboxes/[id]/warmup', () => {
  it('should reject a client-role user', async () => {
    requireUser.mockResolvedValue({ appUser: { id: 'u2', role: 'client' } })
    const response = await POST(req({ profile: 'none' }), context)
    expect(response.status).toBe(403)
    expect(updateMailboxWarmup).not.toHaveBeenCalled()
  })

  it('should 404 an unknown mailbox', async () => {
    getMailboxById.mockResolvedValue(null)
    const response = await POST(req({ profile: 'none' }), context)
    expect(response.status).toBe(404)
  })

  it('should reject a non-integer numeric field', async () => {
    const response = await POST(req({ warmupStartCap: 4.5 }), context)
    expect(response.status).toBe(400)
    expect(updateMailboxWarmup).not.toHaveBeenCalled()
  })

  it('should reject a zero or negative numeric field', async () => {
    const response = await POST(req({ warmupTargetCap: 0 }), context)
    expect(response.status).toBe(400)
    expect(updateMailboxWarmup).not.toHaveBeenCalled()
  })

  it('should update only the numeric fields provided, without resetting the ramp clock', async () => {
    const response = await POST(req({ warmupStartCap: 8, warmupTargetCap: 60 }), context)
    expect(response.status).toBe(200)
    expect(updateMailboxWarmup).toHaveBeenCalledWith(expect.anything(), 'm1', {
      warmup_start_cap: 8,
      warmup_target_cap: 60,
    })
  })

  it('should reset the ramp clock when the profile actually changes', async () => {
    const response = await POST(req({ profile: 'none' }), context)
    expect(response.status).toBe(200)
    expect(updateMailboxWarmup).toHaveBeenCalledWith(expect.anything(), 'm1', {
      warmup_profile: 'none',
      warmup_started_at: null,
    })
  })

  it('should stamp a fresh start time when the profile changes to a ramping one', async () => {
    getMailboxById.mockResolvedValue({
      id: 'm1', client_id: 'c1', warmup_profile: 'none',
      warmup_start_cap: 5, warmup_increment: 3, warmup_target_cap: 40, daily_cap: 40,
    })
    const response = await POST(req({ profile: 'standard' }), context)
    expect(response.status).toBe(200)
    const call = updateMailboxWarmup.mock.calls[0]?.[2] as Record<string, unknown>
    expect(call.warmup_profile).toBe('standard')
    expect(typeof call.warmup_started_at).toBe('string')
  })

  it('should not reset the ramp clock when the same profile value is resent', async () => {
    const response = await POST(req({ profile: 'standard', warmupIncrement: 4 }), context)
    expect(response.status).toBe(200)
    expect(updateMailboxWarmup).toHaveBeenCalledWith(expect.anything(), 'm1', {
      warmup_increment: 4,
    })
  })

  it('should not write anything when the payload changes nothing', async () => {
    const response = await POST(req({ profile: 'standard' }), context)
    expect(response.status).toBe(200)
    expect(updateMailboxWarmup).not.toHaveBeenCalled()
  })
})
