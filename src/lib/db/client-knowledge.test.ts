import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AppError } from '@/lib/errors/app-error'

const embedTextsMock = vi.fn()
vi.mock('@/lib/llm/client', () => ({ embedTexts: (...a: unknown[]) => embedTextsMock(...a) }))

import {
  insertPendingWebsiteSources,
  listSourcesForClient,
  listSourcesForVisibleClients,
  getSourceById,
  markSourceReady,
  markSourceFailed,
  resetSourceToPending,
  deleteSource,
  insertFileSourceReady,
  embedAndStoreChunks,
  deleteChunksForSource,
  matchClientKnowledgeChunks,
} from './client-knowledge'

beforeEach(() => {
  embedTextsMock.mockReset()
})

describe('insertPendingWebsiteSources', () => {
  it('should return [] without querying when pages is empty', async () => {
    const supabase = {} as never
    const result = await insertPendingWebsiteSources(supabase, 'c1', 'op1', [])
    expect(result).toEqual([])
  })

  it('should skip urls that already exist for the client', async () => {
    const selectChain = {
      eq: () => ({ in: () => Promise.resolve({ data: [{ url: 'https://a.com/1' }], error: null }) }),
    }
    const insertMock = vi.fn().mockReturnValue({
      select: () => Promise.resolve({ data: [{ id: 's1', url: 'https://a.com/2' }], error: null }),
    })
    const supabase = {
      from: () => ({ select: () => selectChain, insert: insertMock }),
    } as never
    const result = await insertPendingWebsiteSources(supabase, 'c1', 'op1', [
      { url: 'https://a.com/1', title: 'https://a.com/1' },
      { url: 'https://a.com/2', title: 'https://a.com/2' },
    ])
    expect(insertMock).toHaveBeenCalledWith([
      expect.objectContaining({ url: 'https://a.com/2', client_id: 'c1', created_by: 'op1', status: 'pending' }),
    ])
    expect(result).toEqual([{ id: 's1', url: 'https://a.com/2' }])
  })

  it('should return [] without inserting when every url already exists', async () => {
    const selectChain = { eq: () => ({ in: () => Promise.resolve({ data: [{ url: 'https://a.com/1' }], error: null }) }) }
    const insertMock = vi.fn()
    const supabase = { from: () => ({ select: () => selectChain, insert: insertMock }) } as never
    const result = await insertPendingWebsiteSources(supabase, 'c1', 'op1', [{ url: 'https://a.com/1', title: 'x' }])
    expect(result).toEqual([])
    expect(insertMock).not.toHaveBeenCalled()
  })

  it('should throw DB_ERROR when the existence check fails', async () => {
    const selectChain = { eq: () => ({ in: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }) }
    const supabase = { from: () => ({ select: () => selectChain }) } as never
    await expect(insertPendingWebsiteSources(supabase, 'c1', 'op1', [{ url: 'https://a.com/1', title: 'x' }]))
      .rejects.toBeInstanceOf(AppError)
  })
})

describe('listSourcesForClient', () => {
  it('should return sources ordered newest first', async () => {
    const rows = [{ id: 's1' }]
    const supabase = {
      from: () => ({ select: () => ({ eq: () => ({ order: () => Promise.resolve({ data: rows, error: null }) }) }) }),
    } as never
    const result = await listSourcesForClient(supabase, 'c1')
    expect(result).toEqual(rows)
  })
})

describe('listSourcesForVisibleClients', () => {
  it('should return every source RLS exposes, newest first', async () => {
    const rows = [{ id: 's2' }, { id: 's1' }]
    const orderMock = vi.fn().mockResolvedValue({ data: rows, error: null })
    const supabase = { from: () => ({ select: () => ({ order: orderMock }) }) } as never

    const result = await listSourcesForVisibleClients(supabase)

    expect(result).toEqual(rows)
    expect(orderMock).toHaveBeenCalledWith('created_at', { ascending: false })
  })

  it('should throw DB_ERROR when the query fails', async () => {
    const supabase = {
      from: () => ({ select: () => ({ order: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }) }),
    } as never
    await expect(listSourcesForVisibleClients(supabase)).rejects.toMatchObject({ code: 'DB_ERROR' })
  })
})

describe('getSourceById', () => {
  it('should return null when not found', async () => {
    const supabase = {
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) }),
    } as never
    expect(await getSourceById(supabase, 'missing')).toBeNull()
  })
})

describe('markSourceReady / markSourceFailed / resetSourceToPending', () => {
  it('markSourceReady should update content, char_count, status, scraped_at', async () => {
    const updateMock = vi.fn().mockReturnValue({ eq: () => Promise.resolve({ error: null }) })
    const supabase = { from: () => ({ update: updateMock }) } as never
    await markSourceReady(supabase, 's1', 'full text', 9)
    expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({
      status: 'ready', content: 'full text', char_count: 9,
    }))
  })

  it('markSourceFailed should set status failed with the error message', async () => {
    const updateMock = vi.fn().mockReturnValue({ eq: () => Promise.resolve({ error: null }) })
    const supabase = { from: () => ({ update: updateMock }) } as never
    await markSourceFailed(supabase, 's1', 'scrape timed out')
    expect(updateMock).toHaveBeenCalledWith({ status: 'failed', error_message: 'scrape timed out' })
  })

  it('resetSourceToPending should clear status/content/error', async () => {
    const updateMock = vi.fn().mockReturnValue({ eq: () => Promise.resolve({ error: null }) })
    const supabase = { from: () => ({ update: updateMock }) } as never
    await resetSourceToPending(supabase, 's1')
    expect(updateMock).toHaveBeenCalledWith({ status: 'pending', content: null, char_count: null, error_message: null, scraped_at: null })
  })
})

describe('deleteSource', () => {
  it('should delete and return the deleted row', async () => {
    const row = { id: 's1', storage_path: 'c1/x.pdf' }
    const deleteMock = vi.fn().mockReturnValue({
      eq: () => ({ select: () => ({ maybeSingle: () => Promise.resolve({ data: row, error: null }) }) }),
    })
    const supabase = { from: () => ({ delete: deleteMock }) } as never
    const result = await deleteSource(supabase, 's1')
    expect(result).toEqual(row)
  })
})

describe('insertFileSourceReady', () => {
  it('should insert an already-ready pdf source row', async () => {
    const insertMock = vi.fn().mockReturnValue({
      select: () => ({ single: () => Promise.resolve({ data: { id: 's1' }, error: null }) }),
    })
    const supabase = { from: () => ({ insert: insertMock }) } as never
    const result = await insertFileSourceReady(supabase, {
      clientId: 'c1', createdBy: 'op1', title: 'doc.pdf', storagePath: 'c1/x.pdf', content: 'text', charCount: 4,
      sourceType: 'pdf',
    })
    expect(insertMock).toHaveBeenCalledWith(expect.objectContaining({
      client_id: 'c1', source_type: 'pdf', status: 'ready', storage_path: 'c1/x.pdf',
    }))
    expect(result).toEqual({ id: 's1' })
  })

  it('should write source_type file when the upload is a text file', async () => {
    const insertMock = vi.fn().mockReturnValue({
      select: () => ({ single: () => Promise.resolve({ data: { id: 's1' }, error: null }) }),
    })
    const supabase = { from: () => ({ insert: insertMock }) } as never

    await insertFileSourceReady(supabase, {
      clientId: 'c1', createdBy: 'u1', title: 'notes.md', storagePath: 'p',
      content: 'x', charCount: 1, sourceType: 'file',
    })

    expect(insertMock).toHaveBeenCalledWith(expect.objectContaining({ source_type: 'file' }))
  })
})

describe('embedAndStoreChunks', () => {
  it('should chunk, embed, and insert one row per chunk', async () => {
    embedTextsMock.mockResolvedValue([[0.1], [0.2]])
    const insertMock = vi.fn().mockResolvedValue({ error: null })
    const supabase = { from: () => ({ insert: insertMock }) } as never
    const longText = 'a'.repeat(1500)
    await embedAndStoreChunks(supabase, { clientId: 'c1', sourceId: 's1', content: longText, actor: 'test' })
    expect(embedTextsMock).toHaveBeenCalledWith(
      { clientId: 'c1', actor: 'test' },
      expect.objectContaining({ taskType: 'RETRIEVAL_DOCUMENT' }),
    )
    expect(insertMock).toHaveBeenCalledWith([
      expect.objectContaining({ client_id: 'c1', source_id: 's1', chunk_index: 0, embedding: [0.1] }),
      expect.objectContaining({ client_id: 'c1', source_id: 's1', chunk_index: 1, embedding: [0.2] }),
    ])
  })

  it('should no-op when content produces no chunks', async () => {
    const insertMock = vi.fn()
    const supabase = { from: () => ({ insert: insertMock }) } as never
    await embedAndStoreChunks(supabase, { clientId: 'c1', sourceId: 's1', content: '   ', actor: 'test' })
    expect(embedTextsMock).not.toHaveBeenCalled()
    expect(insertMock).not.toHaveBeenCalled()
  })
})

describe('deleteChunksForSource', () => {
  it('should delete every chunk for the source', async () => {
    const deleteMock = vi.fn().mockReturnValue({ eq: () => Promise.resolve({ error: null }) })
    const supabase = { from: () => ({ delete: deleteMock }) } as never
    await deleteChunksForSource(supabase, 's1')
    expect(deleteMock).toHaveBeenCalled()
  })
})

describe('matchClientKnowledgeChunks', () => {
  it('should call the rpc and return its rows mapped to camelCase', async () => {
    const rows = [{ source_id: 's1', source_title: 'About', content: 'x', similarity: 0.9 }]
    const supabase = { rpc: vi.fn().mockResolvedValue({ data: rows, error: null }) } as never
    const result = await matchClientKnowledgeChunks(supabase, 'c1', [0.1, 0.2], 6)
    expect(result).toEqual([{ sourceId: 's1', sourceTitle: 'About', content: 'x', similarity: 0.9 }])
  })

  it('should throw DB_ERROR when the rpc fails', async () => {
    const supabase = { rpc: vi.fn().mockResolvedValue({ data: null, error: { message: 'boom' } }) } as never
    await expect(matchClientKnowledgeChunks(supabase, 'c1', [0.1], 6)).rejects.toBeInstanceOf(AppError)
  })
})
