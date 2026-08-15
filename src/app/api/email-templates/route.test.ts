import { describe, it, expect, vi, beforeEach } from 'vitest'

const requireUserMock = vi.fn()
const listEmailTemplatesMock = vi.fn()
const createEmailTemplateMock = vi.fn()
const logEventMock = vi.fn()

vi.mock('@/lib/auth/require-user', () => ({ requireUser: (...a: unknown[]) => requireUserMock(...a) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/db/email-templates', () => ({
  listEmailTemplates: (...a: unknown[]) => listEmailTemplatesMock(...a),
  createEmailTemplate: (...a: unknown[]) => createEmailTemplateMock(...a),
}))
vi.mock('@/lib/events/log-event', () => ({ logEvent: (...a: unknown[]) => logEventMock(...a) }))

import { GET, POST } from './route'

function req(body: unknown) {
  return new Request('http://x', { method: 'POST', body: JSON.stringify(body) })
}

beforeEach(() => {
  requireUserMock.mockReset().mockResolvedValue({ appUser: { id: 'op1', role: 'operator' } })
  listEmailTemplatesMock.mockReset()
  createEmailTemplateMock.mockReset()
  logEventMock.mockReset().mockResolvedValue(undefined)
})

describe('GET /api/email-templates', () => {
  it('should return 403 when the caller is not an operator', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'client' } })
    const res = await GET()
    expect(res.status).toBe(403)
    expect(listEmailTemplatesMock).not.toHaveBeenCalled()
  })

  it('should return the list of templates for an operator', async () => {
    const rows = [{ id: 't1', name: 'Concise (default)' }]
    listEmailTemplatesMock.mockResolvedValue(rows)
    const res = await GET()
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.templates).toEqual(rows)
  })
})

describe('POST /api/email-templates', () => {
  it('should return 403 when the caller is not an operator', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'client' } })
    const res = await POST(req({ name: 'Casual', templateText: 'Keep it light.' }))
    expect(res.status).toBe(403)
    expect(createEmailTemplateMock).not.toHaveBeenCalled()
  })

  it('should create the template, log the event, and return it', async () => {
    const template = { id: 't3', name: 'Casual', template_text: 'Keep it light.' }
    createEmailTemplateMock.mockResolvedValue(template)
    const res = await POST(req({ name: 'Casual', templateText: 'Keep it light.' }))
    const json = await res.json()
    expect(res.status).toBe(201)
    expect(json.template).toEqual(template)
    expect(createEmailTemplateMock).toHaveBeenCalledWith(expect.anything(), { name: 'Casual', templateText: 'Keep it light.' })
    expect(logEventMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'email_template.created' }))
  })

  it('should return 400 when name is empty', async () => {
    const res = await POST(req({ name: '', templateText: 'x' }))
    expect(res.status).toBe(400)
    expect(createEmailTemplateMock).not.toHaveBeenCalled()
  })

  it('should return 400 when templateText exceeds 4000 characters', async () => {
    const res = await POST(req({ name: 'Casual', templateText: 'x'.repeat(4001) }))
    expect(res.status).toBe(400)
    expect(createEmailTemplateMock).not.toHaveBeenCalled()
  })

  it('should return 409 when the name is already taken', async () => {
    const { AppError } = await import('@/lib/errors/app-error')
    createEmailTemplateMock.mockRejectedValue(new AppError('EMAIL_TEMPLATE_NAME_TAKEN', 'taken'))
    const res = await POST(req({ name: 'Concise (default)', templateText: 'x' }))
    expect(res.status).toBe(409)
  })
})
