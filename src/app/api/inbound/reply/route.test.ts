import { describe, it, expect, vi, beforeEach } from 'vitest'

const verifyMock = vi.fn()
const runReplyMock = vi.fn()

vi.mock('@/lib/qstash/verify', () => ({ verifyQstashSignature: (...a: unknown[]) => verifyMock(...a) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/pipeline/reply', () => ({ runReplyForInbound: (...a: unknown[]) => runReplyMock(...a) }))

import { POST } from './route'

const EMAIL_ID = '11111111-1111-4111-8111-111111111111'
function req(body: unknown) { return new Request('http://x/api/inbound/reply', { method: 'POST', body: JSON.stringify(body) }) }

beforeEach(() => { verifyMock.mockReset(); runReplyMock.mockReset() })

describe('POST /api/inbound/reply', () => {
  it('should run the reply agent and return the summary', async () => {
    verifyMock.mockResolvedValue(JSON.stringify({ emailId: EMAIL_ID }))
    runReplyMock.mockResolvedValue({ emailId: EMAIL_ID, action: 'answered' })
    const res = await POST(req({}))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.summary.action).toBe('answered')
  })

  it('should return 401 on invalid signature', async () => {
    const { AppError } = await import('@/lib/errors/app-error')
    verifyMock.mockRejectedValue(new AppError('UNAUTHORIZED', 'bad'))
    const res = await POST(req({}))
    expect(res.status).toBe(401)
  })

  it('should return 400 when emailId is missing', async () => {
    verifyMock.mockResolvedValue(JSON.stringify({}))
    const res = await POST(req({}))
    expect(res.status).toBe(400)
  })
})
