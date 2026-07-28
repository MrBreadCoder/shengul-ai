import { describe, it, expect, vi } from 'vitest'
import {
  insertEmailAttachments,
  listAttachmentsForEmail,
  listAttachmentsForEmails,
  replaceEmailAttachments,
} from './email-attachments'

describe('listAttachmentsForEmails', () => {
  it('should return an empty map without querying when there are no ids', async () => {
    const from = vi.fn()
    const supabase = { from } as never
    await expect(listAttachmentsForEmails(supabase, [])).resolves.toEqual(new Map())
    expect(from).not.toHaveBeenCalled()
  })

  it('should group rows by email id', async () => {
    const joined = [
      {
        email_id: 'e1', resource_id: 'r1',
        client_resources: { title: 'A', file_name: 'a.pdf', mime_type: 'application/pdf', byte_size: 1, storage_path: 'p1' },
      },
      {
        email_id: 'e2', resource_id: 'r2',
        client_resources: { title: 'B', file_name: 'b.pdf', mime_type: 'application/pdf', byte_size: 2, storage_path: 'p2' },
      },
      {
        email_id: 'e1', resource_id: 'r3',
        client_resources: { title: 'C', file_name: 'c.pdf', mime_type: 'application/pdf', byte_size: 3, storage_path: 'p3' },
      },
    ]
    const supabase = {
      from: () => ({ select: () => ({ in: () => Promise.resolve({ data: joined, error: null }) }) }),
    } as never

    const result = await listAttachmentsForEmails(supabase, ['e1', 'e2'])

    expect(result.get('e1')?.map((a) => a.resourceId)).toEqual(['r1', 'r3'])
    expect(result.get('e2')?.map((a) => a.title)).toEqual(['B'])
  })

  it('should drop a row whose resource join came back null', async () => {
    const supabase = {
      from: () => ({
        select: () => ({
          in: () => Promise.resolve({
            data: [{ email_id: 'e1', resource_id: 'r1', client_resources: null }],
            error: null,
          }),
        }),
      }),
    } as never
    await expect(listAttachmentsForEmails(supabase, ['e1'])).resolves.toEqual(new Map())
  })

  it('should throw DB_ERROR when the query fails', async () => {
    const supabase = {
      from: () => ({ select: () => ({ in: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }) }),
    } as never
    await expect(listAttachmentsForEmails(supabase, ['e1'])).rejects.toMatchObject({ code: 'DB_ERROR' })
  })
})

describe('insertEmailAttachments', () => {
  it('should do nothing when there are no resource ids', async () => {
    const from = vi.fn()
    const supabase = { from } as never
    await insertEmailAttachments(supabase, { clientId: 'c1', emailId: 'e1', resourceIds: [] })
    expect(from).not.toHaveBeenCalled()
  })

  it('should upsert one row per resource, ignoring duplicates', async () => {
    const upsert = vi.fn().mockResolvedValue({ error: null })
    const supabase = { from: () => ({ upsert }) } as never

    await insertEmailAttachments(supabase, { clientId: 'c1', emailId: 'e1', resourceIds: ['r1', 'r2'] })

    expect(upsert).toHaveBeenCalledWith(
      [
        { client_id: 'c1', email_id: 'e1', resource_id: 'r1' },
        { client_id: 'c1', email_id: 'e1', resource_id: 'r2' },
      ],
      { onConflict: 'email_id,resource_id', ignoreDuplicates: true },
    )
  })

  it('should throw DB_ERROR when the upsert fails', async () => {
    const supabase = {
      from: () => ({ upsert: () => Promise.resolve({ error: { message: 'boom' } }) }),
    } as never
    await expect(
      insertEmailAttachments(supabase, { clientId: 'c1', emailId: 'e1', resourceIds: ['r1'] }),
    ).rejects.toMatchObject({ code: 'DB_ERROR' })
  })
})

describe('listAttachmentsForEmail', () => {
  it('should map the joined resource onto a flat camelCase shape', async () => {
    const joined = [
      {
        resource_id: 'r1',
        client_resources: {
          title: 'Deck', file_name: 'deck.pdf', mime_type: 'application/pdf',
          byte_size: 1000, storage_path: 'c1/x.pdf',
        },
      },
    ]
    const supabase = {
      from: () => ({ select: () => ({ eq: () => Promise.resolve({ data: joined, error: null }) }) }),
    } as never

    await expect(listAttachmentsForEmail(supabase, 'e1')).resolves.toEqual([
      {
        resourceId: 'r1', title: 'Deck', fileName: 'deck.pdf',
        mimeType: 'application/pdf', byteSize: 1000, storagePath: 'c1/x.pdf',
      },
    ])
  })

  it('should drop rows whose resource join came back empty', async () => {
    const supabase = {
      from: () => ({
        select: () => ({ eq: () => Promise.resolve({ data: [{ resource_id: 'r1', client_resources: null }], error: null }) }),
      }),
    } as never
    await expect(listAttachmentsForEmail(supabase, 'e1')).resolves.toEqual([])
  })

  it('should return [] when the email carries nothing', async () => {
    const supabase = {
      from: () => ({ select: () => ({ eq: () => Promise.resolve({ data: null, error: null }) }) }),
    } as never
    await expect(listAttachmentsForEmail(supabase, 'e1')).resolves.toEqual([])
  })

  it('should throw DB_ERROR when the query fails', async () => {
    const supabase = {
      from: () => ({ select: () => ({ eq: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }) }),
    } as never
    await expect(listAttachmentsForEmail(supabase, 'e1')).rejects.toMatchObject({ code: 'DB_ERROR' })
  })
})

describe('replaceEmailAttachments', () => {
  it('should delete the existing set before inserting the new one', async () => {
    const order: string[] = []
    const del = vi.fn().mockReturnValue({
      eq: () => {
        order.push('delete')
        return Promise.resolve({ error: null })
      },
    })
    const upsert = vi.fn().mockImplementation(() => {
      order.push('upsert')
      return Promise.resolve({ error: null })
    })
    const supabase = { from: () => ({ delete: del, upsert }) } as never

    await replaceEmailAttachments(supabase, { clientId: 'c1', emailId: 'e1', resourceIds: ['r2'] })

    expect(order).toEqual(['delete', 'upsert'])
  })

  it('should clear the set when the new list is empty', async () => {
    const upsert = vi.fn()
    const supabase = {
      from: () => ({ delete: () => ({ eq: () => Promise.resolve({ error: null }) }), upsert }),
    } as never
    await replaceEmailAttachments(supabase, { clientId: 'c1', emailId: 'e1', resourceIds: [] })
    expect(upsert).not.toHaveBeenCalled()
  })

  it('should throw DB_ERROR without inserting when the delete fails', async () => {
    const upsert = vi.fn()
    const supabase = {
      from: () => ({
        delete: () => ({ eq: () => Promise.resolve({ error: { message: 'boom' } }) }),
        upsert,
      }),
    } as never
    await expect(
      replaceEmailAttachments(supabase, { clientId: 'c1', emailId: 'e1', resourceIds: ['r1'] }),
    ).rejects.toMatchObject({ code: 'DB_ERROR' })
    expect(upsert).not.toHaveBeenCalled()
  })
})
