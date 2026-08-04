import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AppError } from '@/lib/errors/app-error'

const requireUserMock = vi.fn()
const verifySmtpConnectionMock = vi.fn()
const verifyImapConnectionMock = vi.fn()
const insertMailboxMock = vi.fn()
const resolveMailboxClientIdMock = vi.fn()
const getClientByIdMock = vi.fn()
const logEventMock = vi.fn()
const logWarnMock = vi.fn()
const logErrorMock = vi.fn()

vi.mock('@/lib/auth/require-user', () => ({ requireUser: (...a: unknown[]) => requireUserMock(...a) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/mailbox/smtp-connection', () => ({
  verifySmtpConnection: (...a: unknown[]) => verifySmtpConnectionMock(...a),
  verifyImapConnection: (...a: unknown[]) => verifyImapConnectionMock(...a),
}))
vi.mock('@/lib/db/mailboxes', () => ({ insertMailbox: (...a: unknown[]) => insertMailboxMock(...a) }))
vi.mock('@/lib/db/clients', () => ({
  resolveMailboxClientId: (...a: unknown[]) => resolveMailboxClientIdMock(...a),
  getClientById: (...a: unknown[]) => getClientByIdMock(...a),
}))
vi.mock('@/lib/events/log-event', () => ({
  logEvent: (...a: unknown[]) => logEventMock(...a),
  logWarn: (...a: unknown[]) => logWarnMock(...a),
  logError: (...a: unknown[]) => logErrorMock(...a),
}))

import { POST } from './route'

const validBody = {
  emailAddress: 'ops@client.com',
  displayName: 'Client Ops',
  username: 'ops@client.com',
  password: 'smtp-password-fixture-qhvnz',
  smtpHost: 'smtp.client.com',
  smtpPort: 587,
  smtpSecure: false,
  imapHost: 'imap.client.com',
  imapPort: 993,
  imapSecure: true,
}

function req(body: unknown): Request {
  return new Request('http://x/api/mailboxes/smtp/connect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

beforeEach(() => {
  requireUserMock.mockReset().mockResolvedValue({ appUser: { id: 'op1', role: 'operator', client_id: null } })
  verifySmtpConnectionMock.mockReset().mockResolvedValue(undefined)
  verifyImapConnectionMock.mockReset().mockResolvedValue(undefined)
  insertMailboxMock.mockReset().mockResolvedValue({ id: 'mb1' })
  resolveMailboxClientIdMock.mockReset().mockResolvedValue('client-1')
  getClientByIdMock.mockReset().mockResolvedValue({ id: 'client-1', warmup_profile: 'standard' })
  logEventMock.mockReset().mockResolvedValue(undefined)
  logWarnMock.mockReset().mockResolvedValue(undefined)
  logErrorMock.mockReset().mockResolvedValue(undefined)
})

describe('POST /api/mailboxes/smtp/connect', () => {
  it('should return 403 when the caller is a client with no client_id', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'client', client_id: null } })
    const res = await POST(req(validBody))
    expect(res.status).toBe(403)
    expect(verifySmtpConnectionMock).not.toHaveBeenCalled()
    expect(insertMailboxMock).not.toHaveBeenCalled()
  })

  it('should allow a client-role caller with a client_id to connect a mailbox', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'client', client_id: 'client-1' } })
    const res = await POST(req(validBody))
    expect(res.status).toBe(200)
    expect(resolveMailboxClientIdMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ role: 'client', client_id: 'client-1' }),
    )
    expect(insertMailboxMock).toHaveBeenCalled()
  })

  it('should return 400 when the body is not valid JSON', async () => {
    const res = await POST(req('{not json'))
    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toMatchObject({ error: 'validation_error' })
  })

  it('should return 400 when a required field is missing', async () => {
    const { imapHost: _omitted, ...incomplete } = validBody
    const res = await POST(req(incomplete))
    expect(res.status).toBe(400)
    expect(verifySmtpConnectionMock).not.toHaveBeenCalled()
  })

  it('should return 400 when the port is out of range', async () => {
    const res = await POST(req({ ...validBody, smtpPort: 70000 }))
    expect(res.status).toBe(400)
  })

  it('should insert nothing when SMTP verification fails', async () => {
    verifySmtpConnectionMock.mockRejectedValue(
      new AppError('UNAUTHORIZED', 'rejected', { status: 401, stage: 'smtp' }),
    )
    const res = await POST(req(validBody))
    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toMatchObject({ error: 'auth_failed', stage: 'smtp' })
    expect(verifyImapConnectionMock).not.toHaveBeenCalled()
    expect(insertMailboxMock).not.toHaveBeenCalled()
  })

  it('should log the server response for an operator to diagnose, scoped to the resolved client', async () => {
    verifySmtpConnectionMock.mockRejectedValue(
      new AppError('UNAUTHORIZED', 'rejected', {
        status: 401,
        stage: 'smtp',
        cause: '535 5.7.8 Error: authentication failed',
      }),
    )
    await POST(req(validBody))
    expect(logWarnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: 'client-1',
        type: 'mailbox.connect_failed',
        source: 'mailbox',
        payload: expect.objectContaining({
          stage: 'smtp',
          serverResponse: '535 5.7.8 Error: authentication failed',
        }),
      }),
    )
  })

  it('should insert nothing when IMAP verification fails', async () => {
    verifyImapConnectionMock.mockRejectedValue(
      new AppError('UNAUTHORIZED', 'rejected', { status: 401, stage: 'imap' }),
    )
    const res = await POST(req(validBody))
    await expect(res.json()).resolves.toMatchObject({ error: 'auth_failed', stage: 'imap' })
    expect(insertMailboxMock).not.toHaveBeenCalled()
  })

  it('should report a timeout distinctly from an auth failure', async () => {
    verifySmtpConnectionMock.mockRejectedValue(
      new AppError('EXTERNAL_TIMEOUT', 'too slow', { stage: 'smtp' }),
    )
    const res = await POST(req(validBody))
    expect(res.status).toBe(504)
    await expect(res.json()).resolves.toMatchObject({ error: 'timeout' })
  })

  it('should report an unreachable host as a connection failure', async () => {
    verifySmtpConnectionMock.mockRejectedValue(
      new AppError('EXTERNAL_ERROR', 'no route', { status: 502, stage: 'smtp' }),
    )
    const res = await POST(req(validBody))
    expect(res.status).toBe(502)
    await expect(res.json()).resolves.toMatchObject({ error: 'connection_failed' })
  })

  it('should never return the password or the underlying error message', async () => {
    verifySmtpConnectionMock.mockRejectedValue(
      new AppError('EXTERNAL_ERROR', 'mail.client.com said 550 blocked by policy', {
        status: 502,
        stage: 'smtp',
        cause: 'mail.client.com said 550 blocked by policy',
      }),
    )
    const res = await POST(req(validBody))
    const text = await res.text()
    expect(text).not.toContain('smtp-password-fixture')
    expect(text).not.toContain('blocked by policy')
  })

  it('should insert an smtp mailbox with encrypted credentials and warmup fields on success', async () => {
    const res = await POST(req(validBody))
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ ok: true, mailboxId: 'mb1' })

    const row = insertMailboxMock.mock.calls[0]?.[1] as Record<string, unknown>
    expect(row).toMatchObject({
      client_id: 'client-1',
      provider: 'smtp',
      email_address: 'ops@client.com',
      display_name: 'Client Ops',
      warmup_profile: 'standard',
    })
    expect(row.warmup_started_at).toEqual(expect.any(String))
    expect(JSON.stringify(row.oauth)).not.toContain('smtp-password-fixture')
  })

  it('should log mailbox.connected without the password', async () => {
    await POST(req(validBody))
    const event = logEventMock.mock.calls[0]?.[0] as Record<string, unknown>
    expect(event).toMatchObject({ type: 'mailbox.connected', actor: 'human:op1', clientId: 'client-1' })
    expect(JSON.stringify(event)).not.toContain('smtp-password-fixture')
  })

  it('should return 500 and log the raw db error with no mailboxId on a genuine insert failure', async () => {
    insertMailboxMock.mockRejectedValue(
      new AppError('DB_ERROR', 'Failed to insert mailbox', {
        cause: 'duplicate key value violates unique constraint "mailboxes_client_id_email_address_key"',
      }),
    )
    const res = await POST(req(validBody))
    expect(res.status).toBe(500)
    expect(logErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: 'client-1',
        type: 'mailbox.connect_error',
        source: 'mailbox',
        payload: expect.objectContaining({
          mailboxId: null,
          stage: 'insert',
          dbError: 'duplicate key value violates unique constraint "mailboxes_client_id_email_address_key"',
        }),
      }),
    )
  })

  it('should log the mailboxId when the row was created but the audit-log write failed after', async () => {
    logEventMock.mockRejectedValue(new AppError('DB_ERROR', 'events insert failed', {}))
    const res = await POST(req(validBody))
    expect(res.status).toBe(500)
    expect(logErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ mailboxId: 'mb1', stage: 'post_insert' }),
      }),
    )
  })

  it('should return 403 without verifying credentials when resolving the client is forbidden', async () => {
    resolveMailboxClientIdMock.mockRejectedValue(new AppError('FORBIDDEN', 'no client_id', {}))
    const res = await POST(req(validBody))
    expect(res.status).toBe(403)
    expect(verifySmtpConnectionMock).not.toHaveBeenCalled()
    expect(logErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: null, type: 'mailbox.connect_error' }),
    )
  })

  it('should return 500 without verifying credentials when resolving the client fails unexpectedly', async () => {
    resolveMailboxClientIdMock.mockRejectedValue(new AppError('DB_ERROR', 'boom', {}))
    const res = await POST(req(validBody))
    expect(res.status).toBe(500)
    expect(verifySmtpConnectionMock).not.toHaveBeenCalled()
  })
})
