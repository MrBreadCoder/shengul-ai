import { describe, it, expect, vi, beforeEach } from 'vitest'

const requireUserMock = vi.fn()
const listEmailStylesMock = vi.fn()
const createEmailStyleMock = vi.fn()
const logEventMock = vi.fn()

vi.mock('@/lib/auth/require-user', () => ({ requireUser: (...a: unknown[]) => requireUserMock(...a) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/db/email-styles', () => ({
  listEmailStyles: (...a: unknown[]) => listEmailStylesMock(...a),
  createEmailStyle: (...a: unknown[]) => createEmailStyleMock(...a),
}))
vi.mock('@/lib/events/log-event', () => ({ logEvent: (...a: unknown[]) => logEventMock(...a) }))

import { GET, POST } from './route'

function req(body: unknown) {
  return new Request('http://x', { method: 'POST', body: JSON.stringify(body) })
}

beforeEach(() => {
  requireUserMock.mockReset().mockResolvedValue({ appUser: { id: 'op1', role: 'operator' } })
  listEmailStylesMock.mockReset()
  createEmailStyleMock.mockReset()
  logEventMock.mockReset().mockResolvedValue(undefined)
})

describe('GET /api/email-styles', () => {
  it('should return 403 when the caller is not an operator', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'client' } })
    const res = await GET()
    expect(res.status).toBe(403)
    expect(listEmailStylesMock).not.toHaveBeenCalled()
  })

  it('should return the list of styles for an operator', async () => {
    const rows = [{ id: 's1', name: 'Concise (default)' }]
    listEmailStylesMock.mockResolvedValue(rows)
    const res = await GET()
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.styles).toEqual(rows)
  })
})

describe('POST /api/email-styles', () => {
  it('should return 403 when the caller is not an operator', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'client' } })
    const res = await POST(req({ name: 'Casual', voiceInstructions: 'Keep it light.' }))
    expect(res.status).toBe(403)
    expect(createEmailStyleMock).not.toHaveBeenCalled()
  })

  it('should create the style, log the event, and return it', async () => {
    const style = { id: 's3', name: 'Casual', voice_instructions: 'Keep it light.' }
    createEmailStyleMock.mockResolvedValue(style)
    const res = await POST(req({ name: 'Casual', voiceInstructions: 'Keep it light.' }))
    const json = await res.json()
    expect(res.status).toBe(201)
    expect(json.style).toEqual(style)
    expect(createEmailStyleMock).toHaveBeenCalledWith(expect.anything(), { name: 'Casual', voiceInstructions: 'Keep it light.' })
    expect(logEventMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'email_style.created' }))
  })

  it('should return 400 when name is empty', async () => {
    const res = await POST(req({ name: '', voiceInstructions: 'x' }))
    expect(res.status).toBe(400)
    expect(createEmailStyleMock).not.toHaveBeenCalled()
  })

  it('should return 400 when voiceInstructions exceeds 4000 characters', async () => {
    const res = await POST(req({ name: 'Casual', voiceInstructions: 'x'.repeat(4001) }))
    expect(res.status).toBe(400)
    expect(createEmailStyleMock).not.toHaveBeenCalled()
  })

  it('should return 409 when the name is already taken', async () => {
    const { AppError } = await import('@/lib/errors/app-error')
    createEmailStyleMock.mockRejectedValue(new AppError('EMAIL_STYLE_NAME_TAKEN', 'taken'))
    const res = await POST(req({ name: 'Concise (default)', voiceInstructions: 'x' }))
    expect(res.status).toBe(409)
  })
})
