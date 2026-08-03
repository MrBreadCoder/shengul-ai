import { describe, it, expect, vi, beforeEach } from 'vitest'
import { updateReplyMode } from './reply-mode-actions'

const hoisted = vi.hoisted(() => ({
  requireUser: vi.fn(),
  updateClientReplyMode: vi.fn(),
  syncReplyModeForClient: vi.fn(),
  logEvent: vi.fn(),
}))

vi.mock('@/lib/auth/require-user', () => ({ requireUser: hoisted.requireUser }))
vi.mock('@/lib/db/clients', () => ({ updateClientReplyMode: hoisted.updateClientReplyMode }))
vi.mock('@/lib/db/campaigns', () => ({ syncReplyModeForClient: hoisted.syncReplyModeForClient }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/events/log-event', () => ({ logEvent: hoisted.logEvent }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

function form(replyMode: string): FormData {
  const data = new FormData()
  data.append('replyMode', replyMode)
  return data
}

beforeEach(() => {
  vi.clearAllMocks()
  hoisted.requireUser.mockResolvedValue({ appUser: { id: 'u1', role: 'client', client_id: 'c1' } })
  hoisted.updateClientReplyMode.mockResolvedValue({ id: 'c1', reply_mode: 'auto_send' })
  hoisted.syncReplyModeForClient.mockResolvedValue(undefined)
})

describe('updateReplyMode', () => {
  it('should update the client and sync every campaign for the caller own account', async () => {
    await updateReplyMode(form('auto_send'))

    expect(hoisted.updateClientReplyMode).toHaveBeenCalledWith({}, 'c1', 'auto_send')
    expect(hoisted.syncReplyModeForClient).toHaveBeenCalledWith({}, 'c1', 'auto_send')
    expect(hoisted.logEvent).toHaveBeenCalledWith(expect.objectContaining({
      clientId: 'c1',
      type: 'client.reply_mode_changed',
      payload: { replyMode: 'auto_send' },
    }))
  })

  it('should reject an operator, who does not own a reply-mode preference', async () => {
    hoisted.requireUser.mockResolvedValue({ appUser: { id: 'u1', role: 'operator', client_id: null } })

    await expect(updateReplyMode(form('auto_send'))).rejects.toThrow()
    expect(hoisted.updateClientReplyMode).not.toHaveBeenCalled()
  })

  it('should reject an invalid reply mode value', async () => {
    await expect(updateReplyMode(form('not_a_real_mode'))).rejects.toThrow()
    expect(hoisted.updateClientReplyMode).not.toHaveBeenCalled()
  })
})
