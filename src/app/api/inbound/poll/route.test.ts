import { describe, it, expect, vi, beforeEach } from 'vitest'

const verifyMock = vi.fn()
const getMailboxByIdMock = vi.fn()
const ingestMock = vi.fn()

vi.mock('@/lib/qstash/verify', () => ({ verifyQstashSignature: (...a: unknown[]) => verifyMock(...a) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/db/mailboxes', () => ({ getMailboxById: (...a: unknown[]) => getMailboxByIdMock(...a) }))
vi.mock('@/lib/pipeline/inbound', () => ({ ingestInboundForMailbox: (...a: unknown[]) => ingestMock(...a) }))

import { POST } from './route'

const MAILBOX_ID = '11111111-1111-4111-8111-111111111111'
function req(body: unknown) { return new Request('http://x/api/inbound/poll', { method: 'POST', body: JSON.stringify(body) }) }

beforeEach(() => { for (const m of [verifyMock, getMailboxByIdMock, ingestMock]) m.mockReset() })

describe('POST /api/inbound/poll', () => {
  it('should ingest inbound for the mailbox and return the summary', async () => {
    verifyMock.mockResolvedValue(JSON.stringify({ mailboxId: MAILBOX_ID }))
    getMailboxByIdMock.mockResolvedValue({ id: MAILBOX_ID })
    ingestMock.mockResolvedValue({ mailboxId: MAILBOX_ID, ingested: 1, enqueued: 1 })
    const res = await POST(req({}))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.summary.ingested).toBe(1)
  })

  it('should return 404 when the mailbox is gone', async () => {
    verifyMock.mockResolvedValue(JSON.stringify({ mailboxId: MAILBOX_ID }))
    getMailboxByIdMock.mockResolvedValue(null)
    const res = await POST(req({}))
    expect(res.status).toBe(404)
  })

  it('should return 400 when the body is not valid JSON', async () => {
    verifyMock.mockResolvedValue('not json{')
    const res = await POST(req({}))
    expect(res.status).toBe(400)
  })
})
