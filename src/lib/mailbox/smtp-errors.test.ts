import { describe, it, expect, vi, afterEach } from 'vitest'
import { AppError } from '@/lib/errors/app-error'
import { toMailAppError, withMailDeadline, MAIL_DEADLINE_MS } from './smtp-errors'

// Minimal stand-ins for the error objects nodemailer and imapflow throw.
function mailError(fields: Record<string, unknown>): Error {
  return Object.assign(new Error('mail failure'), fields)
}

describe('toMailAppError', () => {
  it('should map a nodemailer EAUTH failure to UNAUTHORIZED with status 401', () => {
    const mapped = toMailAppError(mailError({ code: 'EAUTH', responseCode: 535 }), 'smtp')
    expect(mapped.code).toBe('UNAUTHORIZED')
    expect(mapped.context).toMatchObject({ status: 401, stage: 'smtp' })
  })

  it('should map an imapflow authenticationFailed error to UNAUTHORIZED with status 401', () => {
    const mapped = toMailAppError(mailError({ authenticationFailed: true }), 'imap')
    expect(mapped.code).toBe('UNAUTHORIZED')
    expect(mapped.context).toMatchObject({ status: 401, stage: 'imap' })
  })

  it('should map a transient SMTP 4xx reply to a retryable status 503', () => {
    // SMTP numbering is inverted vs HTTP: 4xx is "try again later".
    const mapped = toMailAppError(mailError({ responseCode: 451 }), 'smtp')
    expect(mapped.code).toBe('EXTERNAL_ERROR')
    expect(mapped.context).toMatchObject({ status: 503, responseCode: 451 })
  })

  it('should map a permanent SMTP 5xx reply to a non-retryable status 502', () => {
    const mapped = toMailAppError(mailError({ responseCode: 550 }), 'smtp')
    expect(mapped.code).toBe('EXTERNAL_ERROR')
    expect(mapped.context).toMatchObject({ status: 502, responseCode: 550 })
  })

  it('should map a timeout code to EXTERNAL_TIMEOUT', () => {
    const mapped = toMailAppError(mailError({ code: 'ETIMEDOUT' }), 'smtp')
    expect(mapped.code).toBe('EXTERNAL_TIMEOUT')
    expect(mapped.context).toMatchObject({ stage: 'smtp' })
  })

  it('should map a connection failure with no SMTP reply code to status 502', () => {
    const mapped = toMailAppError(mailError({ code: 'ECONNECTION' }), 'smtp')
    expect(mapped.code).toBe('EXTERNAL_ERROR')
    expect(mapped.context).toMatchObject({ status: 502 })
  })

  it('should map an unrecognized error to status 502 rather than throwing', () => {
    const mapped = toMailAppError('a bare string', 'imap')
    expect(mapped.code).toBe('EXTERNAL_ERROR')
    expect(mapped.context).toMatchObject({ status: 502, stage: 'imap' })
  })

  it('should pass an AppError through unchanged', () => {
    const original = new AppError('VALIDATION_ERROR', 'bad header', { field: 'to' })
    expect(toMailAppError(original, 'smtp')).toBe(original)
  })
})

describe('withMailDeadline', () => {
  afterEach(() => vi.useRealTimers())

  it('should resolve with the value when the operation finishes in time', async () => {
    await expect(withMailDeadline('smtp', async () => 'done')).resolves.toBe('done')
  })

  it('should reject with EXTERNAL_TIMEOUT when the operation exceeds the deadline', async () => {
    vi.useFakeTimers()
    const pending = withMailDeadline('imap', () => new Promise<string>(() => {}))
    const assertion = expect(pending).rejects.toMatchObject({ code: 'EXTERNAL_TIMEOUT' })
    await vi.advanceTimersByTimeAsync(MAIL_DEADLINE_MS + 1)
    await assertion
  })

  it('should propagate the original rejection rather than masking it as a timeout', async () => {
    const boom = mailError({ code: 'EAUTH' })
    await expect(withMailDeadline('smtp', () => Promise.reject(boom))).rejects.toBe(boom)
  })
})
