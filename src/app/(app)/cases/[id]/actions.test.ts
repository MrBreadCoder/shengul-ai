import { describe, it, expect, vi, beforeEach } from 'vitest'

const requireUser = vi.fn()
const getLeadById = vi.fn()
const parkLead = vi.fn()
const addSuppression = vi.fn()
const stopSequenceForLead = vi.fn()
const updateSequenceFollowupDelays = vi.fn()
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
vi.mock('@/lib/db/sequences', () => ({
  stopSequenceForLead: (...args: unknown[]) => stopSequenceForLead(...args),
  updateSequenceFollowupDelays: (...args: unknown[]) => updateSequenceFollowupDelays(...args),
}))
vi.mock('@/lib/events/log-event', () => ({ logEventSafe: () => Promise.resolve() }))

const { stopLead, updateLeadFollowupDelays } = await import('./actions')

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

describe('updateLeadFollowupDelays', () => {
  function delaysForm(days: number[]): FormData {
    const data = new FormData()
    data.set('leadId', '11111111-1111-4111-8111-111111111111')
    data.set('caseId', '22222222-2222-4222-8222-222222222222')
    for (const day of days) data.append('delaysDays', String(day))
    return data
  }

  it('should persist the new cadence on that lead\'s sequence', async () => {
    updateSequenceFollowupDelays.mockResolvedValue({ id: 'seq1', followup_delays_days: [2, 5] })

    await updateLeadFollowupDelays(delaysForm([2, 5]))

    expect(updateSequenceFollowupDelays).toHaveBeenCalledWith(
      expect.anything(), '11111111-1111-4111-8111-111111111111', [2, 5],
    )
    expect(revalidatePath).toHaveBeenCalledWith('/cases/22222222-2222-4222-8222-222222222222')
  })

  it('should let a client-role user edit a lead the RLS read returned', async () => {
    requireUser.mockResolvedValue({ appUser: { id: 'u2', role: 'client', client_id: 'c1' } })
    updateSequenceFollowupDelays.mockResolvedValue({ id: 'seq1', followup_delays_days: [2, 5] })

    await updateLeadFollowupDelays(delaysForm([2, 5]))

    expect(updateSequenceFollowupDelays).toHaveBeenCalled()
  })

  it('should reject a lead that belongs to another client', async () => {
    requireUser.mockResolvedValue({ appUser: { id: 'u2', role: 'client', client_id: 'other' } })

    await expect(updateLeadFollowupDelays(delaysForm([2, 5]))).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    expect(updateSequenceFollowupDelays).not.toHaveBeenCalled()
  })

  it('should reject when the RLS-scoped read finds no such lead', async () => {
    getLeadById.mockResolvedValue(null)

    await expect(updateLeadFollowupDelays(delaysForm([2, 5]))).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(updateSequenceFollowupDelays).not.toHaveBeenCalled()
  })

  it('should reject an out-of-bounds cadence before touching the database', async () => {
    await expect(updateLeadFollowupDelays(delaysForm([0]))).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(updateSequenceFollowupDelays).not.toHaveBeenCalled()
  })

  it('should throw VALIDATION_ERROR when the sequence is no longer active or paused', async () => {
    updateSequenceFollowupDelays.mockResolvedValue(null)

    await expect(updateLeadFollowupDelays(delaysForm([2, 5]))).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(revalidatePath).not.toHaveBeenCalled()
  })
})
