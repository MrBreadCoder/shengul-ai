import { describe, it, expect, vi } from 'vitest'
import { listNotesForCase, insertNote, getNoteById, updateNote, deleteNote } from './notes'

const row = {
  id: 'n1', client_id: 'c1', case_id: 'case1', lead_id: null, body: 'Met at a conference',
  created_by: 'u1', created_at: '2026-07-28T00:00:00Z', updated_at: '2026-07-28T00:00:00Z',
}

describe('listNotesForCase', () => {
  it('should return the case notes newest first', async () => {
    const order = vi.fn().mockResolvedValue({ data: [row], error: null })
    const eq = vi.fn().mockReturnValue({ order })
    const supabase = { from: () => ({ select: () => ({ eq }) }) } as never

    const result = await listNotesForCase(supabase, 'case1')

    expect(result).toEqual([row])
    expect(eq).toHaveBeenCalledWith('case_id', 'case1')
    expect(order).toHaveBeenCalledWith('created_at', { ascending: false })
  })

  it('should return an empty array when the table has no rows for the case', async () => {
    const supabase = {
      from: () => ({ select: () => ({ eq: () => ({ order: () => Promise.resolve({ data: null, error: null }) }) }) }),
    } as never
    await expect(listNotesForCase(supabase, 'case1')).resolves.toEqual([])
  })

  it('should throw DB_ERROR when the query fails', async () => {
    const supabase = {
      from: () => ({
        select: () => ({ eq: () => ({ order: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }) }),
      }),
    } as never
    await expect(listNotesForCase(supabase, 'case1')).rejects.toMatchObject({ code: 'DB_ERROR' })
  })
})

describe('insertNote', () => {
  it('should map camelCase input onto snake_case columns', async () => {
    const insert = vi.fn().mockReturnValue({
      select: () => ({ single: () => Promise.resolve({ data: row, error: null }) }),
    })
    const supabase = { from: () => ({ insert }) } as never

    const result = await insertNote(supabase, {
      clientId: 'c1', caseId: 'case1', leadId: null, body: 'Met at a conference', createdBy: 'u1',
    })

    expect(result).toEqual(row)
    expect(insert).toHaveBeenCalledWith({
      client_id: 'c1', case_id: 'case1', lead_id: null, body: 'Met at a conference', created_by: 'u1',
    })
  })

  it('should throw DB_ERROR when RLS refuses the insert', async () => {
    const supabase = {
      from: () => ({
        insert: () => ({ select: () => ({ single: () => Promise.resolve({ data: null, error: { message: 'denied' } }) }) }),
      }),
    } as never
    await expect(
      insertNote(supabase, { clientId: 'c1', caseId: 'case1', leadId: null, body: 'b', createdBy: 'u1' }),
    ).rejects.toMatchObject({ code: 'DB_ERROR' })
  })
})

describe('getNoteById', () => {
  it('should return the note when it is in scope', async () => {
    const eq = vi.fn().mockReturnValue({ maybeSingle: () => Promise.resolve({ data: row, error: null }) })
    const supabase = { from: () => ({ select: () => ({ eq }) }) } as never

    await expect(getNoteById(supabase, 'n1')).resolves.toEqual(row)
    expect(eq).toHaveBeenCalledWith('id', 'n1')
  })

  it('should return null when the note is out of scope or missing', async () => {
    const supabase = {
      from: () => ({
        select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }),
      }),
    } as never
    await expect(getNoteById(supabase, 'n1')).resolves.toBeNull()
  })

  it('should throw DB_ERROR when the read fails', async () => {
    const supabase = {
      from: () => ({
        select: () => ({
          eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }),
        }),
      }),
    } as never
    await expect(getNoteById(supabase, 'n1')).rejects.toMatchObject({ code: 'DB_ERROR' })
  })
})

describe('updateNote', () => {
  it('should write the new body and bump updated_at', async () => {
    const select = vi.fn().mockResolvedValue({ data: [row], error: null })
    const eq = vi.fn().mockReturnValue({ select })
    const update = vi.fn().mockReturnValue({ eq })
    const supabase = { from: () => ({ update }) } as never

    const result = await updateNote(supabase, 'n1', 'Corrected')

    expect(result).toEqual(row)
    expect(eq).toHaveBeenCalledWith('id', 'n1')
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ body: 'Corrected', updated_at: expect.any(String) }),
    )
  })

  it('should return null when no row matched, so a caller can report FORBIDDEN', async () => {
    const supabase = {
      from: () => ({ update: () => ({ eq: () => ({ select: () => Promise.resolve({ data: [], error: null }) }) }) }),
    } as never
    await expect(updateNote(supabase, 'n1', 'x')).resolves.toBeNull()
  })

  it('should throw DB_ERROR when the update fails', async () => {
    const supabase = {
      from: () => ({
        update: () => ({ eq: () => ({ select: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }) }),
      }),
    } as never
    await expect(updateNote(supabase, 'n1', 'x')).rejects.toMatchObject({ code: 'DB_ERROR' })
  })
})

describe('deleteNote', () => {
  it('should report true when a row was removed', async () => {
    const supabase = {
      from: () => ({
        delete: () => ({ eq: () => ({ select: () => Promise.resolve({ data: [{ id: 'n1' }], error: null }) }) }),
      }),
    } as never
    await expect(deleteNote(supabase, 'n1')).resolves.toBe(true)
  })

  it('should report false when RLS matched nothing', async () => {
    const supabase = {
      from: () => ({
        delete: () => ({ eq: () => ({ select: () => Promise.resolve({ data: [], error: null }) }) }),
      }),
    } as never
    await expect(deleteNote(supabase, 'n1')).resolves.toBe(false)
  })

  it('should throw DB_ERROR when the delete fails', async () => {
    const supabase = {
      from: () => ({
        delete: () => ({ eq: () => ({ select: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }) }),
      }),
    } as never
    await expect(deleteNote(supabase, 'n1')).rejects.toMatchObject({ code: 'DB_ERROR' })
  })
})
