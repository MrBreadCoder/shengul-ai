import { describe, it, expect, vi, beforeEach } from 'vitest'

const uploadClientKnowledgeFileMock = vi.fn()
const extractKnowledgeTextMock = vi.fn()
vi.mock('@/lib/storage/client-knowledge-files', () => ({
  uploadClientKnowledgeFile: (...a: unknown[]) => uploadClientKnowledgeFileMock(...a),
  extractKnowledgeText: (...a: unknown[]) => extractKnowledgeTextMock(...a),
  assertValidKnowledgeFile: vi.fn(),
}))
const insertFileSourceReadyMock = vi.fn()
const embedAndStoreChunksMock = vi.fn()
vi.mock('@/lib/db/client-knowledge', () => ({
  insertFileSourceReady: (...a: unknown[]) => insertFileSourceReadyMock(...a),
  embedAndStoreChunks: (...a: unknown[]) => embedAndStoreChunksMock(...a),
}))

import { ingestKnowledgeFile } from './ingest-file'

const supabase = {} as never

beforeEach(() => {
  uploadClientKnowledgeFileMock.mockReset().mockResolvedValue('c1/x.pdf')
  extractKnowledgeTextMock.mockReset().mockResolvedValue('extracted text')
  insertFileSourceReadyMock.mockReset().mockResolvedValue({ id: 's1' })
  embedAndStoreChunksMock.mockReset().mockResolvedValue(undefined)
})

describe('ingestKnowledgeFile', () => {
  it('should upload, extract, insert and embed in that order', async () => {
    const file = new File(['x'], 'notes.md', { type: 'text/markdown' })
    const result = await ingestKnowledgeFile(supabase, {
      clientId: 'c1', createdBy: 'u1', file, actor: 'test',
    })

    expect(result).toEqual({ id: 's1' })
    expect(insertFileSourceReadyMock).toHaveBeenCalledWith(supabase, {
      clientId: 'c1', createdBy: 'u1', title: 'notes.md', storagePath: 'c1/x.pdf',
      content: 'extracted text', charCount: 'extracted text'.length, sourceType: 'file',
    })
    expect(embedAndStoreChunksMock).toHaveBeenCalledWith(supabase, {
      clientId: 'c1', sourceId: 's1', content: 'extracted text', actor: 'test',
    })
  })

  it('should record a pdf upload as source_type pdf', async () => {
    const file = new File(['x'], 'deck.pdf', { type: 'application/pdf' })
    await ingestKnowledgeFile(supabase, { clientId: 'c1', createdBy: 'u1', file, actor: 'test' })
    expect(insertFileSourceReadyMock).toHaveBeenCalledWith(
      supabase, expect.objectContaining({ sourceType: 'pdf' }),
    )
  })
})
