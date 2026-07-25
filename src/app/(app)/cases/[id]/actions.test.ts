import { describe, it, expect, vi, beforeEach } from 'vitest'

const requireUser = vi.fn()
const getLeadById = vi.fn()
const parkLead = vi.fn()
const addSuppression = vi.fn()
const stopSequenceForLead = vi.fn()
const revalidatePath = vi.fn()

vi.mock('@/lib/auth/require-user', () => ({ requireUser: () => requireUser() }))
vi.mock('@/lib/supabase/server', () => ({ createServerClient: () => Promise.resolve({}) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('next/cache', () => ({ revalidatePath: (...args: unknown[]) => revalidatePath(...args) }))
vi.mock('@/lib/db/leads', () => ({
  getLeadById: (...args: unknown[]) => getLeadById(...args),
  parkLead: (...args: unknown[]) => parkLead(...args),
}))
vi.mock('@/lib/db/suppressions', () => ({ addSuppression: (...args: unknown[]) => addSuppression(...args) }))
vi.mock('@/lib/db/sequences', () => ({ stopSequenceForLead: (...args: unknown[]) => stopSequenceForLead(...args) }))
vi.mock('@/lib/events/log-event', () => ({ logEventSafe: () => Promise.resolve() }))

const { stopLead } = await import('./actions')

function form(): FormData {
  const data = new FormData()
  data.set('leadId', '11111111-1111-4111-8111-111111111111')
  data.set('caseId', '22222222-2222-4222-8222-222222222222')
  return data
}

beforeEach(() => {
  vi.clearAllMocks()
  requireUser.mockResolvedValue({ appUser: { id: 'u1', role: 'operator', client_id: null } })
  getLeadById.mockResolvedValue({
    id: '11111111-1111-4111-8111-111111111111',
    client_id: 'c1',
    case_id: '22222222-2222-4222-8222-222222222222',
    email: 'vp@target.com',
  })
})

describe('stopLead', () => {
  it('should suppress, stop the sequence and park the lead', async () => {
    await stopLead(form())
    expect(addSuppression).toHaveBeenCalledWith(expect.anything(), {
      clientId: 'c1', email: 'vp@target.com', reason: 'manual',
    })
    expect(stopSequenceForLead).toHaveBeenCalledWith(expect.anything(), '11111111-1111-4111-8111-111111111111', 'stopped')
    expect(parkLead).toHaveBeenCalledWith(expect.anything(), '11111111-1111-4111-8111-111111111111')
    expect(revalidatePath).toHaveBeenCalledWith('/cases/22222222-2222-4222-8222-222222222222')
  })

  it('should let a client-role user stop a lead the RLS read returned', async () => {
    requireUser.mockResolvedValue({ appUser: { id: 'u2', role: 'client', client_id: 'c1' } })
    await stopLead(form())
    expect(parkLead).toHaveBeenCalled()
  })

  it('should reject when the RLS-scoped read finds no such lead', async () => {
    getLeadById.mockResolvedValue(null)
    await expect(stopLead(form())).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(parkLead).not.toHaveBeenCalled()
  })

  it('should reject a lead that belongs to another client', async () => {
    requireUser.mockResolvedValue({ appUser: { id: 'u2', role: 'client', client_id: 'other' } })
    await expect(stopLead(form())).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    expect(parkLead).not.toHaveBeenCalled()
  })

  it('should park a lead with no email address without suppressing', async () => {
    getLeadById.mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111', client_id: 'c1',
      case_id: '22222222-2222-4222-8222-222222222222', email: null,
    })
    await stopLead(form())
    expect(addSuppression).not.toHaveBeenCalled()
    expect(parkLead).toHaveBeenCalled()
  })

  it('should reject a malformed lead id', async () => {
    const data = new FormData()
    data.set('leadId', 'nope')
    data.set('caseId', '22222222-2222-4222-8222-222222222222')
    await expect(stopLead(data)).rejects.toThrow()
  })
})
