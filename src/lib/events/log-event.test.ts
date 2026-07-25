import { describe, it, expect, vi, beforeEach } from 'vitest'

const insertMock = vi.fn()
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({ from: () => ({ insert: insertMock }) }),
}))

import { logEvent, logEventSafe, logError, logWarn } from './log-event'
import { AppError } from '@/lib/errors/app-error'

describe('logEvent', () => {
  beforeEach(() => insertMock.mockReset())

  it('should insert an event row with info/app defaults when severity and source are omitted', async () => {
    insertMock.mockResolvedValue({ error: null })

    await logEvent({ clientId: 'c1', actor: 'system', type: 'mailbox.connected' })

    expect(insertMock).toHaveBeenCalledWith({
      client_id: 'c1',
      case_id: null,
      actor: 'system',
      type: 'mailbox.connected',
      severity: 'info',
      source: 'app',
      payload: {},
    })
  })

  it('should pass caseId, severity, source and payload through when provided', async () => {
    insertMock.mockResolvedValue({ error: null })

    await logEvent({
      clientId: 'c1',
      caseId: 'case9',
      actor: 'agent:lead-gen',
      type: 'lead.found',
      severity: 'warn',
      source: 'apollo',
      payload: { n: 3 },
    })

    expect(insertMock).toHaveBeenCalledWith({
      client_id: 'c1',
      case_id: 'case9',
      actor: 'agent:lead-gen',
      type: 'lead.found',
      severity: 'warn',
      source: 'apollo',
      payload: { n: 3 },
    })
  })

  it('should throw DB_ERROR when the insert fails', async () => {
    insertMock.mockResolvedValue({ error: { message: 'nope' } })

    await expect(
      logEvent({ clientId: 'c1', actor: 'system', type: 'x' }),
    ).rejects.toBeInstanceOf(AppError)
  })
})

describe('logEventSafe', () => {
  beforeEach(() => insertMock.mockReset())

  it('should resolve without throwing when the insert fails', async () => {
    insertMock.mockResolvedValue({ error: { message: 'nope' } })

    await expect(logEventSafe({ clientId: 'c1', actor: 'system', type: 'x' })).resolves.toBeUndefined()
  })
})

describe('logError', () => {
  beforeEach(() => insertMock.mockReset())

  it('should insert an error row carrying the error code and message in the payload', async () => {
    insertMock.mockResolvedValue({ error: null })

    await logError({
      clientId: 'c1',
      caseId: 'case9',
      actor: 'system',
      type: 'apollo.search.failed',
      source: 'apollo',
      error: new AppError('EXTERNAL_TIMEOUT', 'HTTP request failed', { url: 'x' }),
      payload: { campaignId: 'camp1' },
    })

    expect(insertMock).toHaveBeenCalledWith({
      client_id: 'c1',
      case_id: 'case9',
      actor: 'system',
      type: 'apollo.search.failed',
      severity: 'error',
      source: 'apollo',
      payload: {
        campaignId: 'camp1',
        errorCode: 'EXTERNAL_TIMEOUT',
        errorMessage: 'HTTP request failed',
      },
    })
  })

  it('should not throw when the audit insert itself fails', async () => {
    insertMock.mockResolvedValue({ error: { message: 'audit table gone' } })

    await expect(
      logError({
        clientId: 'c1',
        actor: 'system',
        type: 'apollo.search.failed',
        source: 'apollo',
        error: new Error('boom'),
      }),
    ).resolves.toBeUndefined()
  })
})

describe('logWarn', () => {
  beforeEach(() => insertMock.mockReset())

  it('should insert a warn row rather than an error row', async () => {
    insertMock.mockResolvedValue({ error: null })

    await logWarn({
      clientId: 'c1',
      actor: 'system',
      type: 'mailbox.none_healthy',
      source: 'mailbox',
      error: new AppError('RATE_LIMITED', 'No healthy mailbox available', {}),
    })

    expect(insertMock).toHaveBeenCalledWith({
      client_id: 'c1',
      case_id: null,
      actor: 'system',
      type: 'mailbox.none_healthy',
      severity: 'warn',
      source: 'mailbox',
      payload: { errorCode: 'RATE_LIMITED', errorMessage: 'No healthy mailbox available' },
    })
  })
})
