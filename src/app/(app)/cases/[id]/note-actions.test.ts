import { describe, it, expect, vi, beforeEach } from 'vitest'

const requireUser = vi.fn()
const getCaseById = vi.fn()
const getLeadById = vi.fn()
const insertNote = vi.fn()
const getNoteById = vi.fn()
const updateNote = vi.fn()
const deleteNote = vi.fn()
const revalidatePath = vi.fn()

vi.mock('@/lib/auth/require-user', () => ({ requireUser: () => requireUser() }))
vi.mock('@/lib/supabase/server', () => ({ createServerClient: () => Promise.resolve({}) }))
vi.mock('next/cache', () => ({ revalidatePath: (...args: unknown[]) => revalidatePath(...args) }))
vi.mock('@/lib/db/cases', () => ({ getCaseById: (...a: unknown[]) => getCaseById(...a) }))
vi.mock('@/lib/db/leads', () => ({ getLeadById: (...a: unknown[]) => getLeadById(...a) }))
vi.mock('@/lib/db/notes', () => ({
  insertNote: (...a: unknown[]) => insertNote(...a),
  getNoteById: (...a: unknown[]) => getNoteById(...a),
  updateNote: (...a: unknown[]) => updateNote(...a),
  deleteNote: (...a: unknown[]) => deleteNote(...a),
}))

const { createNote, editNote, removeNote } = await import('./note-actions')

const CASE_ID = '22222222-2222-4222-8222-222222222222'
const LEAD_ID = '11111111-1111-4111-8111-111111111111'
const NOTE_ID = '33333333-3333-4333-8333-333333333333'

function createForm(overrides: Record<string, string> = {}): FormData {
  const data = new FormData()
  data.set('caseId', CASE_ID)
  data.set('leadId', '')
  data.set('body', 'They are re-tendering in Q4')
  for (const [key, value] of Object.entries(overrides)) data.set(key, value)
  return data
}

beforeEach(() => {
  vi.clearAllMocks()
  requireUser.mockResolvedValue({ appUser: { id: 'u1', role: 'client', client_id: 'c1' } })
  getCaseById.mockResolvedValue({ id: CASE_ID, client_id: 'c1' })
  getLeadById.mockResolvedValue({ id: LEAD_ID, client_id: 'c1', case_id: CASE_ID })
  getNoteById.mockResolvedValue({ id: NOTE_ID, client_id: 'c1', case_id: CASE_ID, created_by: 'u1' })
  updateNote.mockResolvedValue({ id: NOTE_ID })
  deleteNote.mockResolvedValue(true)
})

describe('createNote', () => {
  it('should store a company note with lead_id null and the session user as author', async () => {
    await createNote(createForm())
    expect(insertNote).toHaveBeenCalledWith(expect.anything(), {
      clientId: 'c1', caseId: CASE_ID, leadId: null, body: 'They are re-tendering in Q4', createdBy: 'u1',
    })
    expect(revalidatePath).toHaveBeenCalledWith(`/cases/${CASE_ID}`)
  })

  it('should store a person note when a lead on this case is selected', async () => {
    await createNote(createForm({ leadId: LEAD_ID }))
    expect(insertNote).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ leadId: LEAD_ID }),
    )
  })

  it('should trim the body and reject one that is only whitespace', async () => {
    await expect(createNote(createForm({ body: '   ' }))).rejects.toThrow()
    expect(insertNote).not.toHaveBeenCalled()
  })

  it('should reject a case belonging to another client', async () => {
    requireUser.mockResolvedValue({ appUser: { id: 'u2', role: 'client', client_id: 'other' } })
    await expect(createNote(createForm())).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    expect(insertNote).not.toHaveBeenCalled()
  })

  it('should reject when the RLS-scoped read finds no such case', async () => {
    getCaseById.mockResolvedValue(null)
    await expect(createNote(createForm())).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('should reject a lead that belongs to a different case', async () => {
    getLeadById.mockResolvedValue({ id: LEAD_ID, client_id: 'c1', case_id: 'another-case' })
    await expect(createNote(createForm({ leadId: LEAD_ID }))).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    })
    expect(insertNote).not.toHaveBeenCalled()
  })
})

describe('editNote', () => {
  function editForm(): FormData {
    const data = new FormData()
    data.set('noteId', NOTE_ID)
    data.set('caseId', CASE_ID)
    data.set('body', 'Corrected')
    return data
  }

  it('should update the author\'s own note', async () => {
    await editNote(editForm())
    expect(updateNote).toHaveBeenCalledWith(expect.anything(), NOTE_ID, 'Corrected')
    expect(revalidatePath).toHaveBeenCalledWith(`/cases/${CASE_ID}`)
  })

  it('should refuse to edit someone else\'s note', async () => {
    getNoteById.mockResolvedValue({ id: NOTE_ID, client_id: 'c1', case_id: CASE_ID, created_by: 'someone-else' })
    await expect(editNote(editForm())).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(updateNote).not.toHaveBeenCalled()
  })

  it('should let an operator edit any note in scope', async () => {
    requireUser.mockResolvedValue({ appUser: { id: 'op', role: 'operator', client_id: null } })
    getNoteById.mockResolvedValue({ id: NOTE_ID, client_id: 'c1', case_id: CASE_ID, created_by: 'someone-else' })
    await editNote(editForm())
    expect(updateNote).toHaveBeenCalled()
  })

  it('should report NOT_FOUND when the note vanished between read and write', async () => {
    updateNote.mockResolvedValue(null)
    await expect(editNote(editForm())).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('should reject when the submitted caseId does not match the note\'s real case', async () => {
    getNoteById.mockResolvedValue({ id: NOTE_ID, client_id: 'c1', case_id: 'another-case', created_by: 'u1' })
    await expect(editNote(editForm())).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(updateNote).not.toHaveBeenCalled()
  })
})

describe('removeNote', () => {
  function removeForm(): FormData {
    const data = new FormData()
    data.set('noteId', NOTE_ID)
    data.set('caseId', CASE_ID)
    return data
  }

  it('should delete the author\'s own note', async () => {
    await removeNote(removeForm())
    expect(deleteNote).toHaveBeenCalledWith(expect.anything(), NOTE_ID)
    expect(revalidatePath).toHaveBeenCalledWith(`/cases/${CASE_ID}`)
  })

  it('should refuse to delete someone else\'s note', async () => {
    getNoteById.mockResolvedValue({ id: NOTE_ID, client_id: 'c1', case_id: CASE_ID, created_by: 'someone-else' })
    await expect(removeNote(removeForm())).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(deleteNote).not.toHaveBeenCalled()
  })

  it('should be a no-op when the note is already gone', async () => {
    getNoteById.mockResolvedValue(null)
    await removeNote(removeForm())
    expect(deleteNote).not.toHaveBeenCalled()
    expect(revalidatePath).toHaveBeenCalledWith(`/cases/${CASE_ID}`)
  })

  it('should reject when the submitted caseId does not match the note\'s real case', async () => {
    getNoteById.mockResolvedValue({ id: NOTE_ID, client_id: 'c1', case_id: 'another-case', created_by: 'u1' })
    await expect(removeNote(removeForm())).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(deleteNote).not.toHaveBeenCalled()
  })
})
