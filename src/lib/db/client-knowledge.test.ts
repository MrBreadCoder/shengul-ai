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
  listReadySiblingWebsiteContents,
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
      from: () => ({
        select: () => ({ eq: () => ({ order: () => ({ is: () => Promise.resolve({ data: rows, error: null }) }) }) }),
      }),
    } as never
    const result = await listSourcesForClient(supabase, 'c1')
    expect(result).toEqual(rows)
  })

  it('should exclude resource-backed sources so they do not appear as knowledge', async () => {
    const is = vi.fn().mockResolvedValue({ data: [], error: null })
    const order = vi.fn().mockReturnValue({ is })
    const eq = vi.fn().mockReturnValue({ order })
    const supabase = { from: () => ({ select: () => ({ eq }) }) } as never

    await listSourcesForClient(supabase, 'c1')

    expect(is).toHaveBeenCalledWith('resource_id', null)
  })
})

describe('listSourcesForVisibleClients', () => {
  it('should return every source RLS exposes, newest first', async () => {
    const rows = [{ id: 's2' }, { id: 's1' }]
    const is = vi.fn().mockResolvedValue({ data: rows, error: null })
    const orderMock = vi.fn().mockReturnValue({ is })
    const supabase = { from: () => ({ select: () => ({ order: orderMock }) }) } as never

    const result = await listSourcesForVisibleClients(supabase)

    expect(result).toEqual(rows)
    expect(orderMock).toHaveBeenCalledWith('created_at', { ascending: false })
  })

  it('should exclude resource-backed sources so they do not appear as knowledge', async () => {
    const is = vi.fn().mockResolvedValue({ data: [], error: null })
    const order = vi.fn().mockReturnValue({ is })
    const supabase = { from: () => ({ select: () => ({ order }) }) } as never

    await listSourcesForVisibleClients(supabase)

    expect(is).toHaveBeenCalledWith('resource_id', null)
  })

  it('should throw DB_ERROR when the query fails', async () => {
    const supabase = {
      from: () => ({
        select: () => ({ order: () => ({ is: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }) }),
      }),
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
  it('should call the rpc with the query text and return its rows mapped to camelCase', async () => {
    const rows = [{ source_id: 's1', source_title: 'About', resource_id: null, content: 'x', similarity: 0.9 }]
    const rpc = vi.fn().mockResolvedValue({ data: rows, error: null })
    const supabase = { rpc } as never
    const result = await matchClientKnowledgeChunks(supabase, 'c1', [0.1, 0.2], 'pricing question', 6)
    expect(rpc).toHaveBeenCalledWith('match_client_knowledge_chunks', {
      p_client_id: 'c1', p_query_embedding: [0.1, 0.2], p_query_text: 'pricing question', p_limit: 6,
    })
    expect(result).toEqual([
      { sourceId: 's1', sourceTitle: 'About', resourceId: null, content: 'x', similarity: 0.9 },
    ])
  })

  it('should map the resource id through so a fact can be traced to an attachable file', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [
        { source_id: 's1', source_title: 'Deck', resource_id: 'r1', content: 'Three fintech identities.', similarity: 0.8 },
        { source_id: 's2', source_title: 'About', resource_id: null, content: 'Founded 2019.', similarity: 0.7 },
      ],
      error: null,
    })
    const supabase = { rpc } as never

    const result = await matchClientKnowledgeChunks(supabase, 'c1', [0.1], 'q', 6)

    expect(result).toEqual([
      { sourceId: 's1', sourceTitle: 'Deck', resourceId: 'r1', content: 'Three fintech identities.', similarity: 0.8 },
      { sourceId: 's2', sourceTitle: 'About', resourceId: null, content: 'Founded 2019.', similarity: 0.7 },
    ])
  })

  it('should throw DB_ERROR when the rpc fails', async () => {
    const supabase = { rpc: vi.fn().mockResolvedValue({ data: null, error: { message: 'boom' } }) } as never
    await expect(matchClientKnowledgeChunks(supabase, 'c1', [0.1], 'q', 6)).rejects.toBeInstanceOf(AppError)
  })
})

describe('listReadySiblingWebsiteContents', () => {
  it('should return content from ready website-page siblings, excluding the given source and nulls', async () => {
    const rows = [{ content: 'Sibling one.' }, { content: null }, { content: 'Sibling two.' }]
    const eq3 = vi.fn().mockReturnValue({ neq: () => Promise.resolve({ data: rows, error: null }) })
    const eq2 = vi.fn().mockReturnValue({ eq: eq3 })
    const eq1 = vi.fn().mockReturnValue({ eq: eq2 })
    const supabase = { from: () => ({ select: () => ({ eq: eq1 }) }) } as never

    const result = await listReadySiblingWebsiteContents(supabase, 'c1', 's1')

    expect(result).toEqual(['Sibling one.', 'Sibling two.'])
    expect(eq1).toHaveBeenCalledWith('client_id', 'c1')
    expect(eq2).toHaveBeenCalledWith('source_type', 'website_page')
    expect(eq3).toHaveBeenCalledWith('status', 'ready')
  })

  it('should throw DB_ERROR when the query fails', async () => {
    const eq3 = vi.fn().mockReturnValue({ neq: () => Promise.resolve({ data: null, error: { message: 'boom' } }) })
    const eq2 = vi.fn().mockReturnValue({ eq: eq3 })
    const eq1 = vi.fn().mockReturnValue({ eq: eq2 })
    const supabase = { from: () => ({ select: () => ({ eq: eq1 }) }) } as never
    await expect(listReadySiblingWebsiteContents(supabase, 'c1', 's1')).rejects.toBeInstanceOf(AppError)
  })
})
