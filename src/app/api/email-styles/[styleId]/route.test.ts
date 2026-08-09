import { describe, it, expect, vi, beforeEach } from 'vitest'

const requireUserMock = vi.fn()
const updateEmailStyleMock = vi.fn()
const setDefaultEmailStyleMock = vi.fn()
const deleteEmailStyleMock = vi.fn()
const logEventMock = vi.fn()

vi.mock('@/lib/auth/require-user', () => ({ requireUser: (...a: unknown[]) => requireUserMock(...a) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/db/email-styles', () => ({
  updateEmailStyle: (...a: unknown[]) => updateEmailStyleMock(...a),
  setDefaultEmailStyle: (...a: unknown[]) => setDefaultEmailStyleMock(...a),
  deleteEmailStyle: (...a: unknown[]) => deleteEmailStyleMock(...a),
}))
vi.mock('@/lib/events/log-event', () => ({ logEvent: (...a: unknown[]) => logEventMock(...a) }))

import { PATCH, DELETE } from './route'

function patchReq(body: unknown) {
  return new Request('http://x', { method: 'PATCH', body: JSON.stringify(body) })
}
function ctx(styleId: string) {
  return { params: Promise.resolve({ styleId }) }
}

beforeEach(() => {
  requireUserMock.mockReset().mockResolvedValue({ appUser: { id: 'op1', role: 'operator' } })
  updateEmailStyleMock.mockReset()
  setDefaultEmailStyleMock.mockReset()
  deleteEmailStyleMock.mockReset()
  logEventMock.mockReset().mockResolvedValue(undefined)
})

describe('PATCH /api/email-styles/[styleId]', () => {
  it('should return 403 when the caller is not an operator', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'client' } })
    const res = await PATCH(patchReq({ name: 'New name' }), ctx('s1'))
    expect(res.status).toBe(403)
  })

  it('should update the name/voiceInstructions and return the style', async () => {
    const style = { id: 's1', name: 'New name', voice_instructions: 'New text.' }
    updateEmailStyleMock.mockResolvedValue(style)
    const res = await PATCH(patchReq({ name: 'New name', voiceInstructions: 'New text.' }), ctx('s1'))
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.style).toEqual(style)
    expect(updateEmailStyleMock).toHaveBeenCalledWith(expect.anything(), 's1', { name: 'New name', voiceInstructions: 'New text.' })
    expect(setDefaultEmailStyleMock).not.toHaveBeenCalled()
    expect(logEventMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'email_style.updated' }))
  })

  it('should call setDefaultEmailStyle and not updateEmailStyle when isDefault is true', async () => {
    const style = { id: 's2', name: 'Formal introduction', is_default: true }
    setDefaultEmailStyleMock.mockResolvedValue(style)
    const res = await PATCH(patchReq({ isDefault: true }), ctx('s2'))
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.style).toEqual(style)
    expect(setDefaultEmailStyleMock).toHaveBeenCalledWith(expect.anything(), 's2')
    expect(updateEmailStyleMock).not.toHaveBeenCalled()
    expect(logEventMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'email_style.default_changed' }))
  })

  it('should return 400 when isDefault is combined with name', async () => {
    const res = await PATCH(patchReq({ isDefault: true, name: 'X' }), ctx('s1'))
    expect(res.status).toBe(400)
    expect(setDefaultEmailStyleMock).not.toHaveBeenCalled()
  })

  it('should return 400 when no field is provided', async () => {
    const res = await PATCH(patchReq({}), ctx('s1'))
    expect(res.status).toBe(400)
  })

  it('should return 404 when the style does not exist', async () => {
    const { AppError } = await import('@/lib/errors/app-error')
    updateEmailStyleMock.mockRejectedValue(new AppError('EMAIL_STYLE_NOT_FOUND', 'not found'))
    const res = await PATCH(patchReq({ name: 'X' }), ctx('missing'))
    expect(res.status).toBe(404)
  })

  it('should return 409 when the new name is already taken', async () => {
    const { AppError } = await import('@/lib/errors/app-error')
    updateEmailStyleMock.mockRejectedValue(new AppError('EMAIL_STYLE_NAME_TAKEN', 'taken'))
    const res = await PATCH(patchReq({ name: 'Concise (default)' }), ctx('s2'))
    expect(res.status).toBe(409)
  })
})

describe('DELETE /api/email-styles/[styleId]', () => {
  it('should return 403 when the caller is not an operator', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'client' } })
    const res = await DELETE(new Request('http://x', { method: 'DELETE' }), ctx('s3'))
    expect(res.status).toBe(403)
    expect(deleteEmailStyleMock).not.toHaveBeenCalled()
  })

  it('should delete the style and log the event', async () => {
    deleteEmailStyleMock.mockResolvedValue(undefined)
    const res = await DELETE(new Request('http://x', { method: 'DELETE' }), ctx('s3'))
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.ok).toBe(true)
    expect(deleteEmailStyleMock).toHaveBeenCalledWith(expect.anything(), 's3')
    expect(logEventMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'email_style.deleted' }))
  })

  it('should return 409 when deleting the default style', async () => {
    const { AppError } = await import('@/lib/errors/app-error')
    deleteEmailStyleMock.mockRejectedValue(new AppError('CANNOT_DELETE_DEFAULT_STYLE', 'cannot delete default'))
    const res = await DELETE(new Request('http://x', { method: 'DELETE' }), ctx('s1'))
    expect(res.status).toBe(409)
  })

  it('should return 404 when the style does not exist', async () => {
    const { AppError } = await import('@/lib/errors/app-error')
    deleteEmailStyleMock.mockRejectedValue(new AppError('EMAIL_STYLE_NOT_FOUND', 'not found'))
    const res = await DELETE(new Request('http://x', { method: 'DELETE' }), ctx('missing'))
    expect(res.status).toBe(404)
  })
})
