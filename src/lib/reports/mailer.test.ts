import { describe, it, expect, vi, beforeEach } from 'vitest'

const sendMailMock = vi.hoisted(() => vi.fn())
const closeMock = vi.hoisted(() => vi.fn())
const createTransportMock = vi.hoisted(() => vi.fn(() => ({ sendMail: sendMailMock, close: closeMock })))

vi.mock('nodemailer', () => ({ default: { createTransport: createTransportMock } }))
vi.mock('@/lib/env', () => ({
  env: {
    REPORTS_SMTP_HOST: 'smtp.shengulai.com',
    REPORTS_SMTP_PORT: 587,
    REPORTS_SMTP_SECURE: false,
    REPORTS_SMTP_USERNAME: 'shengul@shengulai.com',
    REPORTS_SMTP_PASSWORD: 'app-password',
    REPORTS_FROM_EMAIL: 'shengul@shengulai.com',
    REPORTS_FROM_NAME: 'Shengul Yavuz',
  },
}))

import { sendReportEmail } from './mailer'
import { AppError } from '@/lib/errors/app-error'

function sentOptions(): Record<string, unknown> {
  return sendMailMock.mock.calls[0]?.[0] as Record<string, unknown>
}

beforeEach(() => {
  sendMailMock.mockReset().mockResolvedValue({ messageId: '<x@shengulai.com>' })
  closeMock.mockReset()
  createTransportMock.mockClear()
})

describe('sendReportEmail', () => {
  it('should send from the configured name/address, BCC to itself', async () => {
    await sendReportEmail({ to: 'client@acme.com', subject: 'Hi', text: 'body', html: '<p>body</p>' })
    expect(sentOptions()).toMatchObject({
      from: '"Shengul Yavuz" <shengul@shengulai.com>',
      to: 'client@acme.com',
      bcc: 'shengul@shengulai.com',
      subject: 'Hi',
      text: 'body',
      html: '<p>body</p>',
    })
  })

  it('should configure the transport from the REPORTS_SMTP_* env vars', async () => {
    await sendReportEmail({ to: 'client@acme.com', subject: 'Hi', text: 'body', html: '<p>body</p>' })
    expect(createTransportMock).toHaveBeenCalledWith(
      expect.objectContaining({
        host: 'smtp.shengulai.com',
        port: 587,
        secure: false,
        auth: { user: 'shengul@shengulai.com', pass: 'app-password' },
      }),
    )
  })

  it('should reject a subject containing a line break', async () => {
    await expect(
      sendReportEmail({ to: 'client@acme.com', subject: 'Hi\nInjected', text: 'body', html: '<p>body</p>' }),
    ).rejects.toBeInstanceOf(AppError)
    expect(sendMailMock).not.toHaveBeenCalled()
  })

  it('should map an SMTP send failure to AppError and still close the transport', async () => {
    sendMailMock.mockRejectedValue(new Error('smtp refused'))
    await expect(
      sendReportEmail({ to: 'client@acme.com', subject: 'Hi', text: 'body', html: '<p>body</p>' }),
    ).rejects.toBeInstanceOf(AppError)
    expect(closeMock).toHaveBeenCalled()
  })
})
