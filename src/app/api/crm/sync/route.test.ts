import { describe, it, expect, vi, beforeEach } from 'vitest'
import { POST } from './route'
import { AppError } from '@/lib/errors/app-error'

const hoisted = vi.hoisted(() => ({
  verifyQstashSignature: vi.fn(),
  runCrmSync: vi.fn(),
}))

vi.mock('@/lib/qstash/verify', () => ({ verifyQstashSignature: hoisted.verifyQstashSignature }))
vi.mock('@/lib/crm/sync', () => ({ runCrmSync: hoisted.runCrmSync }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/events/log-event', () => ({ logError: vi.fn() }))

const caseId = '11111111-2222-4333-8444-555555555555'

function request(): Request {
  return new Request('https://app.test/api/crm/sync', { method: 'POST' })
}

beforeEach(() => {
  vi.clearAllMocks()
  hoisted.verifyQstashSignature.mockResolvedValue(JSON.stringify({ caseId, reason: 'qualified' }))
  hoisted.runCrmSync.mockResolvedValue({ kind: 'synced' })
})

describe('POST /api/crm/sync', () => {
  it('should return 401 when the QStash signature is missing or invalid', async () => {
    hoisted.verifyQstashSignature.mockRejectedValue(new AppError('UNAUTHORIZED', 'bad signature'))

    expect((await POST(request())).status).toBe(401)
  })

  it('should return 400 when the body is not valid JSON', async () => {
    hoisted.verifyQstashSignature.mockResolvedValue('not json')

    expect((await POST(request())).status).toBe(400)
  })

  it('should return 400 when the case id is not a uuid', async () => {
    hoisted.verifyQstashSignature.mockResolvedValue(JSON.stringify({ caseId: 'nope', reason: 'qualified' }))

    expect((await POST(request())).status).toBe(400)
  })

  it('should return 400 when the reason is outside the allowed set', async () => {
    hoisted.verifyQstashSignature.mockResolvedValue(JSON.stringify({ caseId, reason: 'invented' }))

    expect((await POST(request())).status).toBe(400)
  })

  it('should return 200 when the sync succeeds', async () => {
    const response = await POST(request())

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true })
    expect(hoisted.runCrmSync).toHaveBeenCalledWith({}, expect.objectContaining({ caseId, reason: 'qualified' }))
  })

  it('should return 200 with the reason when the sync is skipped', async () => {
    hoisted.runCrmSync.mockResolvedValue({ kind: 'skipped', reason: 'no_connection' })

    const response = await POST(request())

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true, skipped: 'no_connection' })
  })

  it('should return 500 so QStash retries when another worker holds the claim', async () => {
    hoisted.runCrmSync.mockResolvedValue({ kind: 'busy' })

    expect((await POST(request())).status).toBe(500)
  })

  it('should return 200 when the failure is permanent and retrying cannot help', async () => {
    hoisted.runCrmSync.mockResolvedValue({ kind: 'permanent_failure', message: 'bad field' })

    const response = await POST(request())

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: false, error: 'bad field' })
  })

  it('should return 500 so QStash retries when the sync throws a retryable error', async () => {
    hoisted.runCrmSync.mockRejectedValue(new AppError('EXTERNAL_ERROR', 'HTTP 503', { status: 503 }))

    expect((await POST(request())).status).toBe(500)
  })
})
