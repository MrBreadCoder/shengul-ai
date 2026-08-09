import { describe, it, expect, vi } from 'vitest'
import {
  listEmailStyles,
  getEmailStyleById,
  getDefaultEmailStyle,
  createEmailStyle,
  updateEmailStyle,
  setDefaultEmailStyle,
  deleteEmailStyle,
} from './email-styles'
import { AppError } from '@/lib/errors/app-error'

describe('listEmailStyles', () => {
  it('should return every style ordered by name', async () => {
    const rows = [{ id: 's1', name: 'Concise (default)' }, { id: 's2', name: 'Formal introduction' }]
    const supabase = {
      from: () => ({ select: () => ({ order: () => Promise.resolve({ data: rows, error: null }) }) }),
    } as never
    const result = await listEmailStyles(supabase)
    expect(result).toEqual(rows)
  })

  it('should throw DB_ERROR on query failure', async () => {
    const supabase = {
      from: () => ({ select: () => ({ order: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }) }),
    } as never
    await expect(listEmailStyles(supabase)).rejects.toBeInstanceOf(AppError)
  })
})

describe('getEmailStyleById', () => {
  it('should return the style row when found', async () => {
    const row = { id: 's1', name: 'Concise (default)' }
    const supabase = {
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: row, error: null }) }) }) }),
    } as never
    const result = await getEmailStyleById(supabase, 's1')
    expect(result).toEqual(row)
  })

  it('should return null when not found', async () => {
    const supabase = {
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) }),
    } as never
    const result = await getEmailStyleById(supabase, 'missing')
    expect(result).toBeNull()
  })

  it('should throw DB_ERROR on query failure', async () => {
    const supabase = {
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }) }) }),
    } as never
    await expect(getEmailStyleById(supabase, 's1')).rejects.toBeInstanceOf(AppError)
  })
})

describe('getDefaultEmailStyle', () => {
  it('should return the row marked is_default', async () => {
    const row = { id: 's1', name: 'Concise (default)', is_default: true }
    const supabase = {
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: row, error: null }) }) }) }),
    } as never
    const result = await getDefaultEmailStyle(supabase)
    expect(result).toEqual(row)
  })

  it('should throw INVARIANT_VIOLATION when no row is marked default', async () => {
    const supabase = {
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) }),
    } as never
    await expect(getDefaultEmailStyle(supabase)).rejects.toMatchObject({ code: 'INVARIANT_VIOLATION' })
  })

  it('should throw DB_ERROR on query failure', async () => {
    const supabase = {
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }) }) }),
    } as never
    await expect(getDefaultEmailStyle(supabase)).rejects.toMatchObject({ code: 'DB_ERROR' })
  })
})

describe('createEmailStyle', () => {
  it('should insert and return the new style row', async () => {
    const row = { id: 's3', name: 'Casual', voice_instructions: 'Keep it light.', is_default: false }
    const insert = vi.fn().mockReturnValue({
      select: () => ({ single: () => Promise.resolve({ data: row, error: null }) }),
    })
    const result = await createEmailStyle({ from: () => ({ insert }) } as never, {
      name: 'Casual',
      voiceInstructions: 'Keep it light.',
    })
    expect(insert).toHaveBeenCalledWith({ name: 'Casual', voice_instructions: 'Keep it light.' })
    expect(result).toEqual(row)
  })

  it('should throw EMAIL_STYLE_NAME_TAKEN on a unique-constraint conflict', async () => {
    const supabase = {
      from: () => ({
        insert: () => ({ select: () => ({ single: () => Promise.resolve({ data: null, error: { code: '23505', message: 'duplicate key' } }) }) }),
      }),
    } as never
    await expect(createEmailStyle(supabase, { name: 'Concise (default)', voiceInstructions: 'x' })).rejects.toMatchObject({
      code: 'EMAIL_STYLE_NAME_TAKEN',
    })
  })

  it('should throw DB_ERROR on any other insert failure', async () => {
    const supabase = {
      from: () => ({
        insert: () => ({ select: () => ({ single: () => Promise.resolve({ data: null, error: { code: '500', message: 'boom' } }) }) }),
      }),
    } as never
    await expect(createEmailStyle(supabase, { name: 'Casual', voiceInstructions: 'x' })).rejects.toMatchObject({
      code: 'DB_ERROR',
    })
  })
})

describe('updateEmailStyle', () => {
  it('should update only the provided fields and return the row', async () => {
    const row = { id: 's1', name: 'Concise', voice_instructions: 'New text.' }
    const update = vi.fn().mockReturnValue({
      eq: () => ({ select: () => ({ maybeSingle: () => Promise.resolve({ data: row, error: null }) }) }),
    })
    const result = await updateEmailStyle({ from: () => ({ update }) } as never, 's1', { voiceInstructions: 'New text.' })
    expect(update).toHaveBeenCalledWith({ voice_instructions: 'New text.' })
    expect(result).toEqual(row)
  })

  it('should throw EMAIL_STYLE_NOT_FOUND when no row matches the id', async () => {
    const supabase = {
      from: () => ({ update: () => ({ eq: () => ({ select: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) }) }),
    } as never
    await expect(updateEmailStyle(supabase, 'missing', { name: 'X' })).rejects.toMatchObject({ code: 'EMAIL_STYLE_NOT_FOUND' })
  })

  it('should throw EMAIL_STYLE_NAME_TAKEN on a unique-constraint conflict', async () => {
    const supabase = {
      from: () => ({
        update: () => ({ eq: () => ({ select: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: { code: '23505', message: 'duplicate key' } }) }) }) }),
      }),
    } as never
    await expect(updateEmailStyle(supabase, 's1', { name: 'Formal introduction' })).rejects.toMatchObject({
      code: 'EMAIL_STYLE_NAME_TAKEN',
    })
  })

  it('should throw DB_ERROR on any other update failure', async () => {
    const supabase = {
      from: () => ({
        update: () => ({ eq: () => ({ select: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: { code: '500', message: 'boom' } }) }) }) }),
      }),
    } as never
    await expect(updateEmailStyle(supabase, 's1', { name: 'X' })).rejects.toMatchObject({ code: 'DB_ERROR' })
  })
})

describe('setDefaultEmailStyle', () => {
  it('should call the set_default_email_style RPC and return the new default row', async () => {
    const row = { id: 's2', name: 'Formal introduction', is_default: true }
    const rpc = vi.fn().mockReturnValue(Promise.resolve({ data: [row], error: null }))
    const result = await setDefaultEmailStyle({ rpc } as never, 's2')
    expect(rpc).toHaveBeenCalledWith('set_default_email_style', { p_id: 's2' })
    expect(result).toEqual(row)
  })

  it('should throw EMAIL_STYLE_NOT_FOUND when the RPC raises P0002', async () => {
    const supabase = { rpc: () => Promise.resolve({ data: null, error: { code: 'P0002', message: 'not found' } }) } as never
    await expect(setDefaultEmailStyle(supabase, 'missing')).rejects.toMatchObject({ code: 'EMAIL_STYLE_NOT_FOUND' })
  })

  it('should throw DB_ERROR on any other RPC failure', async () => {
    const supabase = { rpc: () => Promise.resolve({ data: null, error: { code: '500', message: 'boom' } }) } as never
    await expect(setDefaultEmailStyle(supabase, 's1')).rejects.toMatchObject({ code: 'DB_ERROR' })
  })
})

describe('deleteEmailStyle', () => {
  it('should reassign referencing clients to null then delete the style', async () => {
    const style = { id: 's3', name: 'Casual', is_default: false }
    const getById = vi.fn(() => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: style, error: null }) }) }))
    const clientsUpdate = vi.fn().mockReturnValue({ eq: () => Promise.resolve({ error: null }) })
    const stylesDelete = vi.fn().mockReturnValue({ eq: () => Promise.resolve({ error: null }) })
    const from = vi.fn((table: string) => {
      if (table === 'email_styles') return { select: getById, delete: stylesDelete }
      if (table === 'clients') return { update: clientsUpdate }
      throw new Error(`unexpected table ${table}`)
    })
    await deleteEmailStyle({ from } as never, 's3')
    expect(clientsUpdate).toHaveBeenCalledWith({ email_style_id: null })
    expect(stylesDelete).toHaveBeenCalled()
  })

  it('should throw EMAIL_STYLE_NOT_FOUND when the style does not exist', async () => {
    const from = vi.fn(() => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) }))
    await expect(deleteEmailStyle({ from } as never, 'missing')).rejects.toMatchObject({ code: 'EMAIL_STYLE_NOT_FOUND' })
  })

  it('should throw CANNOT_DELETE_DEFAULT_STYLE when the style is_default', async () => {
    const style = { id: 's1', name: 'Concise (default)', is_default: true }
    const from = vi.fn(() => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: style, error: null }) }) }) }))
    await expect(deleteEmailStyle({ from } as never, 's1')).rejects.toMatchObject({ code: 'CANNOT_DELETE_DEFAULT_STYLE' })
  })
})
