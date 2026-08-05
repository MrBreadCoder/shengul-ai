import { describe, it, expect, vi, beforeEach } from 'vitest'
import { updateFollowupCadence } from './followup-cadence-actions'

const hoisted = vi.hoisted(() => ({
  requireUser: vi.fn(),
  updateClientFollowupDelays: vi.fn(),
  logEvent: vi.fn(),
}))

vi.mock('@/lib/auth/require-user', () => ({ requireUser: hoisted.requireUser }))
vi.mock('@/lib/db/clients', () => ({ updateClientFollowupDelays: hoisted.updateClientFollowupDelays }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/events/log-event', () => ({ logEvent: hoisted.logEvent }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

function form(days: number[]): FormData {
  const data = new FormData()
  for (const day of days) data.append('delaysDays', String(day))
  return data
}

beforeEach(() => {
  vi.clearAllMocks()
  hoisted.requireUser.mockResolvedValue({ appUser: { id: 'u1', role: 'client', client_id: 'c1' } })
  hoisted.updateClientFollowupDelays.mockResolvedValue({ id: 'c1', followup_delays_days: [2, 5, 9] })
})

describe('updateFollowupCadence', () => {
  it('should update the client-wide default cadence', async () => {
    await updateFollowupCadence(form([2, 5, 9]))

    expect(hoisted.updateClientFollowupDelays).toHaveBeenCalledWith({}, 'c1', [2, 5, 9])
    expect(hoisted.logEvent).toHaveBeenCalledWith(expect.objectContaining({
      clientId: 'c1',
      type: 'client.followup_cadence_changed',
      payload: { delaysDays: [2, 5, 9] },
    }))
  })

  it('should reject an operator, who does not own a cadence preference', async () => {
    hoisted.requireUser.mockResolvedValue({ appUser: { id: 'u1', role: 'operator', client_id: null } })

    await expect(updateFollowupCadence(form([2, 5, 9]))).rejects.toThrow()
    expect(hoisted.updateClientFollowupDelays).not.toHaveBeenCalled()
  })

  it('should reject an empty cadence', async () => {
    await expect(updateFollowupCadence(form([]))).rejects.toThrow()
    expect(hoisted.updateClientFollowupDelays).not.toHaveBeenCalled()
  })

  it('should reject a day value out of bounds', async () => {
    await expect(updateFollowupCadence(form([0]))).rejects.toThrow()
    expect(hoisted.updateClientFollowupDelays).not.toHaveBeenCalled()
  })
})
