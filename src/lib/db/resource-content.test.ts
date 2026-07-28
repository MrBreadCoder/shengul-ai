import { describe, it, expect, vi } from 'vitest'
import {
  markResourceContentReady,
  markResourceContentFailed,
  markResourceContentUnsupported,
  resetResourceContentToPending,
  upsertResourceKnowledgeSource,
  deleteResourceKnowledgeSource,
  listResourcesAwaitingContent,
} from './resource-content'

function updateBuilder(result: { error: { message: string } | null }) {
  const eq = vi.fn().mockResolvedValue(result)
  const update = vi.fn().mockReturnValue({ eq })
  return { supabase: { from: () => ({ update }) } as never, update, eq }
}

describe('markResourceContentReady', () => {
  it('should store the content, the summary, a read timestamp and clear any prior error', async () => {
    const { supabase, update, eq } = updateBuilder({ error: null })

    await markResourceContentReady(supabase, { resourceId: 'r1', content: 'body', summary: 'sum' })

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        content_status: 'ready',
        content: 'body',
        content_summary: 'sum',
        content_error: null,
      }),
    )
    expect((update.mock.calls[0]?.[0] as { read_at: string }).read_at).toEqual(expect.any(String))
    expect(eq).toHaveBeenCalledWith('id', 'r1')
  })

  it('should throw DB_ERROR when the update fails', async () => {
    const { supabase } = updateBuilder({ error: { message: 'boom' } })
    await expect(
      markResourceContentReady(supabase, { resourceId: 'r1', content: 'b', summary: 's' }),
    ).rejects.toMatchObject({ code: 'DB_ERROR' })
  })
})

describe('markResourceContentFailed', () => {
  it('should record the failure message and leave no stale summary behind', async () => {
    const { supabase, update, eq } = updateBuilder({ error: null })

    await markResourceContentFailed(supabase, 'r1', 'Could not read the file')

    expect(update).toHaveBeenCalledWith({
      content_status: 'failed',
      content_error: 'Could not read the file',
      content: null,
      content_summary: null,
      read_at: null,
    })
    expect(eq).toHaveBeenCalledWith('id', 'r1')
  })

  it('should throw DB_ERROR when the update fails', async () => {
    const { supabase } = updateBuilder({ error: { message: 'boom' } })
    await expect(markResourceContentFailed(supabase, 'r1', 'x')).rejects.toMatchObject({ code: 'DB_ERROR' })
  })
})

describe('markResourceContentUnsupported', () => {
  it('should mark the row unsupported without recording an error message', async () => {
    const { supabase, update } = updateBuilder({ error: null })

    await markResourceContentUnsupported(supabase, 'r1')

    expect(update).toHaveBeenCalledWith({
      content_status: 'unsupported',
      content_error: null,
      content: null,
      content_summary: null,
      read_at: null,
    })
  })
})

describe('resetResourceContentToPending', () => {
  it('should clear every derived field so a re-read starts clean', async () => {
    const { supabase, update } = updateBuilder({ error: null })

    await resetResourceContentToPending(supabase, 'r1')

    expect(update).toHaveBeenCalledWith({
      content_status: 'pending',
      content: null,
      content_summary: null,
      content_error: null,
      read_at: null,
    })
  })
})

describe('upsertResourceKnowledgeSource', () => {
  const input = {
    clientId: 'c1', resourceId: 'r1', createdBy: 'u1', title: 'Deck', content: 'twelve projects',
  }

  it('should insert a ready resource source when none exists yet', async () => {
    const maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null })
    const insert = vi.fn().mockReturnValue({
      select: () => ({ single: () => Promise.resolve({ data: { id: 's1' }, error: null }) }),
    })
    const supabase = {
      from: () => ({
        select: () => ({ eq: () => ({ maybeSingle }) }),
        insert,
      }),
    } as never

    const sourceId = await upsertResourceKnowledgeSource(supabase, input)

    expect(sourceId).toBe('s1')
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        client_id: 'c1',
        resource_id: 'r1',
        source_type: 'resource',
        title: 'Deck',
        content: 'twelve projects',
        char_count: 'twelve projects'.length,
        status: 'ready',
        created_by: 'u1',
      }),
    )
    // The bytes live in the client-resources bucket, not the knowledge bucket.
    expect(insert.mock.calls[0]?.[0]).not.toHaveProperty('storage_path')
  })

  it('should update the existing source instead of inserting a second one on a retry', async () => {
    const maybeSingle = vi.fn().mockResolvedValue({ data: { id: 's1' }, error: null })
    const eq = vi.fn().mockResolvedValue({ error: null })
    const update = vi.fn().mockReturnValue({ eq })
    const insert = vi.fn()
    const supabase = {
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle }) }), update, insert }),
    } as never

    const sourceId = await upsertResourceKnowledgeSource(supabase, input)

    expect(sourceId).toBe('s1')
    expect(insert).not.toHaveBeenCalled()
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ content: 'twelve projects' }))
    expect(eq).toHaveBeenCalledWith('id', 's1')
  })

  it('should throw DB_ERROR when the lookup fails', async () => {
    const maybeSingle = vi.fn().mockResolvedValue({ data: null, error: { message: 'boom' } })
    const supabase = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle }) }) }) } as never
    await expect(upsertResourceKnowledgeSource(supabase, input)).rejects.toMatchObject({ code: 'DB_ERROR' })
  })

  it('should throw DB_ERROR when the insert fails', async () => {
    const maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null })
    const supabase = {
      from: () => ({
        select: () => ({ eq: () => ({ maybeSingle }) }),
        insert: () => ({ select: () => ({ single: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }) }),
      }),
    } as never
    await expect(upsertResourceKnowledgeSource(supabase, input)).rejects.toMatchObject({ code: 'DB_ERROR' })
  })
})

describe('deleteResourceKnowledgeSource', () => {
  it('should delete the source for the resource so its chunks cascade away', async () => {
    const eq = vi.fn().mockResolvedValue({ error: null })
    const del = vi.fn().mockReturnValue({ eq })
    const supabase = { from: () => ({ delete: del }) } as never

    await deleteResourceKnowledgeSource(supabase, 'r1')

    expect(eq).toHaveBeenCalledWith('resource_id', 'r1')
  })

  it('should throw DB_ERROR when the delete fails', async () => {
    const supabase = {
      from: () => ({ delete: () => ({ eq: () => Promise.resolve({ error: { message: 'boom' } }) }) }),
    } as never
    await expect(deleteResourceKnowledgeSource(supabase, 'r1')).rejects.toMatchObject({ code: 'DB_ERROR' })
  })
})

describe('listResourcesAwaitingContent', () => {
  it('should return active pending rows oldest first within the limit', async () => {
    const limit = vi.fn().mockResolvedValue({ data: [{ id: 'r1', client_id: 'c1' }], error: null })
    const order = vi.fn().mockReturnValue({ limit })
    const eqStatus = vi.fn().mockReturnValue({ order })
    const eqActive = vi.fn().mockReturnValue({ eq: eqStatus })
    const supabase = { from: () => ({ select: () => ({ eq: eqActive }) }) } as never

    const result = await listResourcesAwaitingContent(supabase, 500)

    expect(result).toEqual([{ id: 'r1', client_id: 'c1' }])
    expect(eqActive).toHaveBeenCalledWith('is_active', true)
    expect(eqStatus).toHaveBeenCalledWith('content_status', 'pending')
    expect(order).toHaveBeenCalledWith('created_at', { ascending: true })
    expect(limit).toHaveBeenCalledWith(500)
  })

  it('should throw DB_ERROR when the query fails', async () => {
    const supabase = {
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              order: () => ({ limit: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }),
            }),
          }),
        }),
      }),
    } as never
    await expect(listResourcesAwaitingContent(supabase, 10)).rejects.toMatchObject({ code: 'DB_ERROR' })
  })
})
