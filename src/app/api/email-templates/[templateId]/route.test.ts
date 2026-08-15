import { describe, it, expect, vi, beforeEach } from 'vitest'

const requireUserMock = vi.fn()
const updateEmailTemplateMock = vi.fn()
const setDefaultEmailTemplateMock = vi.fn()
const deleteEmailTemplateMock = vi.fn()
const logEventMock = vi.fn()

vi.mock('@/lib/auth/require-user', () => ({ requireUser: (...a: unknown[]) => requireUserMock(...a) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/db/email-templates', () => ({
  updateEmailTemplate: (...a: unknown[]) => updateEmailTemplateMock(...a),
  setDefaultEmailTemplate: (...a: unknown[]) => setDefaultEmailTemplateMock(...a),
  deleteEmailTemplate: (...a: unknown[]) => deleteEmailTemplateMock(...a),
}))
vi.mock('@/lib/events/log-event', () => ({ logEvent: (...a: unknown[]) => logEventMock(...a) }))

import { PATCH, DELETE } from './route'

function patchReq(body: unknown) {
  return new Request('http://x', { method: 'PATCH', body: JSON.stringify(body) })
}
function ctx(templateId: string) {
  return { params: Promise.resolve({ templateId }) }
}

beforeEach(() => {
  requireUserMock.mockReset().mockResolvedValue({ appUser: { id: 'op1', role: 'operator' } })
  updateEmailTemplateMock.mockReset()
  setDefaultEmailTemplateMock.mockReset()
  deleteEmailTemplateMock.mockReset()
  logEventMock.mockReset().mockResolvedValue(undefined)
})

describe('PATCH /api/email-templates/[templateId]', () => {
  it('should return 403 when the caller is not an operator', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'client' } })
    const res = await PATCH(patchReq({ name: 'New name' }), ctx('t1'))
    expect(res.status).toBe(403)
  })

  it('should update the name/templateText and return the template', async () => {
    const template = { id: 't1', name: 'New name', template_text: 'New text.' }
    updateEmailTemplateMock.mockResolvedValue(template)
    const res = await PATCH(patchReq({ name: 'New name', templateText: 'New text.' }), ctx('t1'))
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.template).toEqual(template)
    expect(updateEmailTemplateMock).toHaveBeenCalledWith(expect.anything(), 't1', { name: 'New name', templateText: 'New text.' })
    expect(setDefaultEmailTemplateMock).not.toHaveBeenCalled()
    expect(logEventMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'email_template.updated' }))
  })

  it('should call setDefaultEmailTemplate and not updateEmailTemplate when isDefault is true', async () => {
    const template = { id: 't2', name: 'Formal introduction', is_default: true }
    setDefaultEmailTemplateMock.mockResolvedValue(template)
    const res = await PATCH(patchReq({ isDefault: true }), ctx('t2'))
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.template).toEqual(template)
    expect(setDefaultEmailTemplateMock).toHaveBeenCalledWith(expect.anything(), 't2')
    expect(updateEmailTemplateMock).not.toHaveBeenCalled()
    expect(logEventMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'email_template.default_changed' }))
  })

  it('should return 400 when isDefault is combined with name', async () => {
    const res = await PATCH(patchReq({ isDefault: true, name: 'X' }), ctx('t1'))
    expect(res.status).toBe(400)
    expect(setDefaultEmailTemplateMock).not.toHaveBeenCalled()
  })

  it('should return 400 when no field is provided', async () => {
    const res = await PATCH(patchReq({}), ctx('t1'))
    expect(res.status).toBe(400)
  })

  it('should return 404 when the template does not exist', async () => {
    const { AppError } = await import('@/lib/errors/app-error')
    updateEmailTemplateMock.mockRejectedValue(new AppError('EMAIL_TEMPLATE_NOT_FOUND', 'not found'))
    const res = await PATCH(patchReq({ name: 'X' }), ctx('missing'))
    expect(res.status).toBe(404)
  })

  it('should return 409 when the new name is already taken', async () => {
    const { AppError } = await import('@/lib/errors/app-error')
    updateEmailTemplateMock.mockRejectedValue(new AppError('EMAIL_TEMPLATE_NAME_TAKEN', 'taken'))
    const res = await PATCH(patchReq({ name: 'Concise (default)' }), ctx('t2'))
    expect(res.status).toBe(409)
  })
})

describe('DELETE /api/email-templates/[templateId]', () => {
  it('should return 403 when the caller is not an operator', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'client' } })
    const res = await DELETE(new Request('http://x', { method: 'DELETE' }), ctx('t3'))
    expect(res.status).toBe(403)
    expect(deleteEmailTemplateMock).not.toHaveBeenCalled()
  })

  it('should delete the template and log the event', async () => {
    deleteEmailTemplateMock.mockResolvedValue(undefined)
    const res = await DELETE(new Request('http://x', { method: 'DELETE' }), ctx('t3'))
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.ok).toBe(true)
    expect(deleteEmailTemplateMock).toHaveBeenCalledWith(expect.anything(), 't3')
    expect(logEventMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'email_template.deleted' }))
  })

  it('should return 409 when deleting the default template', async () => {
    const { AppError } = await import('@/lib/errors/app-error')
    deleteEmailTemplateMock.mockRejectedValue(new AppError('CANNOT_DELETE_DEFAULT_TEMPLATE', 'cannot delete default'))
    const res = await DELETE(new Request('http://x', { method: 'DELETE' }), ctx('t1'))
    expect(res.status).toBe(409)
  })

  it('should return 404 when the template does not exist', async () => {
    const { AppError } = await import('@/lib/errors/app-error')
    deleteEmailTemplateMock.mockRejectedValue(new AppError('EMAIL_TEMPLATE_NOT_FOUND', 'not found'))
    const res = await DELETE(new Request('http://x', { method: 'DELETE' }), ctx('missing'))
    expect(res.status).toBe(404)
  })
})
