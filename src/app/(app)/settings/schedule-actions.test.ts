import { describe, it, expect, vi, beforeEach } from 'vitest'
import { updateSchedule } from './schedule-actions'

const hoisted = vi.hoisted(() => ({
  requireUser: vi.fn(),
  updateClientSchedule: vi.fn(),
  recomputeClientCampaignSchedules: vi.fn(),
  logEvent: vi.fn(),
}))

vi.mock('@/lib/auth/require-user', () => ({ requireUser: hoisted.requireUser }))
vi.mock('@/lib/db/clients', () => ({ updateClientSchedule: hoisted.updateClientSchedule }))
vi.mock('@/lib/db/campaigns', () => ({ recomputeClientCampaignSchedules: hoisted.recomputeClientCampaignSchedules }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/events/log-event', () => ({ logEvent: hoisted.logEvent }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

function form(timezone: string, defaultDiscoverTime: string): FormData {
  const data = new FormData()
  data.set('timezone', timezone)
  data.set('defaultDiscoverTime', defaultDiscoverTime)
  return data
}

beforeEach(() => {
  vi.clearAllMocks()
  hoisted.requireUser.mockResolvedValue({ appUser: { id: 'u1', role: 'client', client_id: 'c1' } })
  hoisted.updateClientSchedule.mockResolvedValue({ id: 'c1', timezone: 'Europe/Istanbul', default_discover_time: '08:00' })
  hoisted.recomputeClientCampaignSchedules.mockResolvedValue(undefined)
})

describe('updateSchedule', () => {
  it("should update the client's schedule and recompute its campaigns", async () => {
    await updateSchedule(form('Europe/Istanbul', '08:00'))

    expect(hoisted.updateClientSchedule).toHaveBeenCalledWith({}, 'c1', {
      timezone: 'Europe/Istanbul',
      default_discover_time: '08:00',
    })
    expect(hoisted.recomputeClientCampaignSchedules).toHaveBeenCalledWith({}, 'c1')
    expect(hoisted.logEvent).toHaveBeenCalledWith(expect.objectContaining({
      clientId: 'c1',
      type: 'client.schedule_changed',
      payload: { timezone: 'Europe/Istanbul', defaultDiscoverTime: '08:00' },
    }))
  })

  it('should reject an operator, who does not own a schedule preference', async () => {
    hoisted.requireUser.mockResolvedValue({ appUser: { id: 'u1', role: 'operator', client_id: null } })

    await expect(updateSchedule(form('UTC', '06:00'))).rejects.toThrow()
    expect(hoisted.updateClientSchedule).not.toHaveBeenCalled()
  })

  it('should reject an invalid timezone', async () => {
    await expect(updateSchedule(form('Not/AZone', '06:00'))).rejects.toThrow()
    expect(hoisted.updateClientSchedule).not.toHaveBeenCalled()
  })

  it('should reject a malformed time', async () => {
    await expect(updateSchedule(form('UTC', '9:00'))).rejects.toThrow()
    expect(hoisted.updateClientSchedule).not.toHaveBeenCalled()
  })
})
