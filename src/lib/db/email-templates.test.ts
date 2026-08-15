import { describe, it, expect, vi } from 'vitest'
import {
  listEmailTemplates,
  getEmailTemplateById,
  getDefaultEmailTemplate,
  createEmailTemplate,
  updateEmailTemplate,
  setDefaultEmailTemplate,
  deleteEmailTemplate,
} from './email-templates'
import { AppError } from '@/lib/errors/app-error'

describe('listEmailTemplates', () => {
  it('should return every template ordered by name', async () => {
    const rows = [{ id: 't1', name: 'Concise (default)' }, { id: 't2', name: 'Formal introduction' }]
    const supabase = {
      from: () => ({ select: () => ({ order: () => Promise.resolve({ data: rows, error: null }) }) }),
    } as never
    const result = await listEmailTemplates(supabase)
    expect(result).toEqual(rows)
  })

  it('should throw DB_ERROR on query failure', async () => {
    const supabase = {
      from: () => ({ select: () => ({ order: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }) }),
    } as never
    await expect(listEmailTemplates(supabase)).rejects.toBeInstanceOf(AppError)
  })
})

describe('getEmailTemplateById', () => {
  it('should return the template row when found', async () => {
    const row = { id: 't1', name: 'Concise (default)' }
    const supabase = {
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: row, error: null }) }) }) }),
    } as never
    const result = await getEmailTemplateById(supabase, 't1')
    expect(result).toEqual(row)
  })

  it('should return null when not found', async () => {
    const supabase = {
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) }),
    } as never
    const result = await getEmailTemplateById(supabase, 'missing')
    expect(result).toBeNull()
  })

  it('should throw DB_ERROR on query failure', async () => {
    const supabase = {
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }) }) }),
    } as never
    await expect(getEmailTemplateById(supabase, 't1')).rejects.toBeInstanceOf(AppError)
  })
})

describe('getDefaultEmailTemplate', () => {
  it('should return the row marked is_default', async () => {
    const row = { id: 't1', name: 'Concise (default)', is_default: true }
    const supabase = {
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: row, error: null }) }) }) }),
    } as never
    const result = await getDefaultEmailTemplate(supabase)
    expect(result).toEqual(row)
  })

  it('should throw INVARIANT_VIOLATION when no row is marked default', async () => {
    const supabase = {
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) }),
    } as never
    await expect(getDefaultEmailTemplate(supabase)).rejects.toMatchObject({ code: 'INVARIANT_VIOLATION' })
  })

  it('should throw DB_ERROR on query failure', async () => {
    const supabase = {
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }) }) }),
    } as never
    await expect(getDefaultEmailTemplate(supabase)).rejects.toMatchObject({ code: 'DB_ERROR' })
  })
})

describe('createEmailTemplate', () => {
  it('should insert and return the new template row', async () => {
    const row = { id: 't3', name: 'Casual', template_text: 'Keep it light.', is_default: false }
    const insert = vi.fn().mockReturnValue({
      select: () => ({ single: () => Promise.resolve({ data: row, error: null }) }),
    })
    const result = await createEmailTemplate({ from: () => ({ insert }) } as never, {
      name: 'Casual',
      templateText: 'Keep it light.',
    })
    expect(insert).toHaveBeenCalledWith({ name: 'Casual', template_text: 'Keep it light.' })
    expect(result).toEqual(row)
  })

  it('should throw EMAIL_TEMPLATE_NAME_TAKEN on a unique-constraint conflict', async () => {
    const supabase = {
      from: () => ({
        insert: () => ({ select: () => ({ single: () => Promise.resolve({ data: null, error: { code: '23505', message: 'duplicate key' } }) }) }),
      }),
    } as never
    await expect(createEmailTemplate(supabase, { name: 'Concise (default)', templateText: 'x' })).rejects.toMatchObject({
      code: 'EMAIL_TEMPLATE_NAME_TAKEN',
    })
  })

  it('should throw DB_ERROR on any other insert failure', async () => {
    const supabase = {
      from: () => ({
        insert: () => ({ select: () => ({ single: () => Promise.resolve({ data: null, error: { code: '500', message: 'boom' } }) }) }),
      }),
    } as never
    await expect(createEmailTemplate(supabase, { name: 'Casual', templateText: 'x' })).rejects.toMatchObject({
      code: 'DB_ERROR',
    })
  })
})

describe('updateEmailTemplate', () => {
  it('should update only the provided fields and return the row', async () => {
    const row = { id: 't1', name: 'Concise', template_text: 'New text.' }
    const update = vi.fn().mockReturnValue({
      eq: () => ({ select: () => ({ maybeSingle: () => Promise.resolve({ data: row, error: null }) }) }),
    })
    const result = await updateEmailTemplate({ from: () => ({ update }) } as never, 't1', { templateText: 'New text.' })
    expect(update).toHaveBeenCalledWith({ template_text: 'New text.' })
    expect(result).toEqual(row)
  })

  it('should throw EMAIL_TEMPLATE_NOT_FOUND when no row matches the id', async () => {
    const supabase = {
      from: () => ({ update: () => ({ eq: () => ({ select: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) }) }),
    } as never
    await expect(updateEmailTemplate(supabase, 'missing', { name: 'X' })).rejects.toMatchObject({ code: 'EMAIL_TEMPLATE_NOT_FOUND' })
  })

  it('should throw EMAIL_TEMPLATE_NAME_TAKEN on a unique-constraint conflict', async () => {
    const supabase = {
      from: () => ({
        update: () => ({ eq: () => ({ select: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: { code: '23505', message: 'duplicate key' } }) }) }) }),
      }),
    } as never
    await expect(updateEmailTemplate(supabase, 't1', { name: 'Formal introduction' })).rejects.toMatchObject({
      code: 'EMAIL_TEMPLATE_NAME_TAKEN',
    })
  })

  it('should throw DB_ERROR on any other update failure', async () => {
    const supabase = {
      from: () => ({
        update: () => ({ eq: () => ({ select: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: { code: '500', message: 'boom' } }) }) }) }),
      }),
    } as never
    await expect(updateEmailTemplate(supabase, 't1', { name: 'X' })).rejects.toMatchObject({ code: 'DB_ERROR' })
  })
})

describe('setDefaultEmailTemplate', () => {
  it('should call the set_default_email_template RPC and return the new default row', async () => {
    const row = { id: 't2', name: 'Formal introduction', is_default: true }
    const rpc = vi.fn().mockReturnValue(Promise.resolve({ data: [row], error: null }))
    const result = await setDefaultEmailTemplate({ rpc } as never, 't2')
    expect(rpc).toHaveBeenCalledWith('set_default_email_template', { p_id: 't2' })
    expect(result).toEqual(row)
  })

  it('should throw EMAIL_TEMPLATE_NOT_FOUND when the RPC raises P0002', async () => {
    const supabase = { rpc: () => Promise.resolve({ data: null, error: { code: 'P0002', message: 'not found' } }) } as never
    await expect(setDefaultEmailTemplate(supabase, 'missing')).rejects.toMatchObject({ code: 'EMAIL_TEMPLATE_NOT_FOUND' })
  })

  it('should throw DB_ERROR on any other RPC failure', async () => {
    const supabase = { rpc: () => Promise.resolve({ data: null, error: { code: '500', message: 'boom' } }) } as never
    await expect(setDefaultEmailTemplate(supabase, 't1')).rejects.toMatchObject({ code: 'DB_ERROR' })
  })
})

describe('deleteEmailTemplate', () => {
  it('should reassign referencing clients and campaigns to null then delete the template', async () => {
    const template = { id: 't3', name: 'Casual', is_default: false }
    const getById = vi.fn(() => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: template, error: null }) }) }))
    const clientsUpdate = vi.fn().mockReturnValue({ eq: () => Promise.resolve({ error: null }) })
    const campaignsUpdate = vi.fn().mockReturnValue({ eq: () => Promise.resolve({ error: null }) })
    const templatesDelete = vi.fn().mockReturnValue({ eq: () => Promise.resolve({ error: null }) })
    const from = vi.fn((table: string) => {
      if (table === 'email_templates') return { select: getById, delete: templatesDelete }
      if (table === 'clients') return { update: clientsUpdate }
      if (table === 'campaigns') return { update: campaignsUpdate }
      throw new Error(`unexpected table ${table}`)
    })
    await deleteEmailTemplate({ from } as never, 't3')
    expect(clientsUpdate).toHaveBeenCalledWith({ email_template_id: null })
    expect(campaignsUpdate).toHaveBeenCalledWith({ email_template_id: null })
    expect(templatesDelete).toHaveBeenCalled()
  })

  it('should throw EMAIL_TEMPLATE_NOT_FOUND when the template does not exist', async () => {
    const from = vi.fn(() => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) }))
    await expect(deleteEmailTemplate({ from } as never, 'missing')).rejects.toMatchObject({ code: 'EMAIL_TEMPLATE_NOT_FOUND' })
  })

  it('should throw CANNOT_DELETE_DEFAULT_TEMPLATE when the template is_default', async () => {
    const template = { id: 't1', name: 'Concise (default)', is_default: true }
    const from = vi.fn(() => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: template, error: null }) }) }) }))
    await expect(deleteEmailTemplate({ from } as never, 't1')).rejects.toMatchObject({ code: 'CANNOT_DELETE_DEFAULT_TEMPLATE' })
  })
})
