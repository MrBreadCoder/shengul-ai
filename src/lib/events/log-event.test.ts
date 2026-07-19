import { describe, it, expect, vi, beforeEach } from 'vitest'

const insertMock = vi.fn()
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({ from: () => ({ insert: insertMock }) }),
}))

import { logEvent } from './log-event'
import { AppError } from '@/lib/errors/app-error'

describe('logEvent', () => {
  beforeEach(() => insertMock.mockReset())

  it('should insert an event row with defaults when minimal input is given', async () => {
    insertMock.mockResolvedValue({ error: null })
    await logEvent({ clientId: 'c1', actor: 'system', type: 'mailbox.connected' })
    expect(insertMock).toHaveBeenCalledWith({
      client_id: 'c1', case_id: null, actor: 'system', type: 'mailbox.connected', payload: {},
    })
  })

  it('should pass caseId and payload through when provided', async () => {
    insertMock.mockResolvedValue({ error: null })
    await logEvent({ clientId: 'c1', caseId: 'case9', actor: 'agent:lead-gen', type: 'lead.found', payload: { n: 3 } })
    expect(insertMock).toHaveBeenCalledWith({
      client_id: 'c1', case_id: 'case9', actor: 'agent:lead-gen', type: 'lead.found', payload: { n: 3 },
    })
  })

  it('should throw DB_ERROR when the insert fails', async () => {
    insertMock.mockResolvedValue({ error: { message: 'nope' } })
    await expect(
      logEvent({ clientId: 'c1', actor: 'system', type: 'x' }),
    ).rejects.toBeInstanceOf(AppError)
  })
})
