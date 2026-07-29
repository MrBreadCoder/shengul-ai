import { describe, it, expect, vi, beforeEach } from 'vitest'

const verifyQstashSignature = vi.fn()
const runMailreachStatsSync = vi.fn()

vi.mock('@/lib/qstash/verify', () => ({ verifyQstashSignature: (...args: unknown[]) => verifyQstashSignature(...args) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/pipeline/mailreach-sync', () => ({
  runMailreachStatsSync: (...args: unknown[]) => runMailreachStatsSync(...args),
}))
vi.mock('@/lib/events/log-event', () => ({ logEventSafe: () => Promise.resolve() }))

const { POST } = await import('./route')

beforeEach(() => {
  vi.clearAllMocks()
  verifyQstashSignature.mockResolvedValue(undefined)
  runMailreachStatsSync.mockResolvedValue({ evaluated: 3, failed: 0 })
})

describe('POST /api/pipeline/mailreach-sync', () => {
  it('should run the sweep and return the summary', async () => {
    const response = await POST(new Request('http://x', { method: 'POST' }))
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toEqual({ ok: true, evaluated: 3, failed: 0 })
  })

  it('should return 401 when the qstash signature is invalid', async () => {
    const { AppError } = await import('@/lib/errors/app-error')
    verifyQstashSignature.mockRejectedValue(new AppError('UNAUTHORIZED', 'bad signature'))
    const response = await POST(new Request('http://x', { method: 'POST' }))
    expect(response.status).toBe(401)
  })
})
