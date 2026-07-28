import { describe, it, expect, vi, beforeEach } from 'vitest'

const getActiveResourcesByIdsMock = vi.fn()
const downloadClientResourceMock = vi.fn()
vi.mock('@/lib/db/client-resources', () => ({
  getActiveResourcesByIds: (...a: unknown[]) => getActiveResourcesByIdsMock(...a),
}))
vi.mock('@/lib/storage/client-resources', () => ({
  downloadClientResource: (...a: unknown[]) => downloadClientResourceMock(...a),
}))

import { loadResourceAttachments } from './load-attachments'

const supabase = {} as never

beforeEach(() => {
  getActiveResourcesByIdsMock.mockReset()
  downloadClientResourceMock.mockReset()
})

describe('loadResourceAttachments', () => {
  it('should return [] without querying when there are no ids', async () => {
    await expect(loadResourceAttachments(supabase, 'c1', [])).resolves.toEqual([])
    expect(getActiveResourcesByIdsMock).not.toHaveBeenCalled()
  })

  it('should download each resource and shape it as an EmailAttachment', async () => {
    getActiveResourcesByIdsMock.mockResolvedValue([
      {
        id: 'r1',
        file_name: 'deck.pdf',
        mime_type: 'application/pdf',
        byte_size: 3,
        storage_path: 'c1/a.pdf',
      },
    ])
    downloadClientResourceMock.mockResolvedValue(Buffer.from('abc'))

    await expect(loadResourceAttachments(supabase, 'c1', ['r1'])).resolves.toEqual([
      { fileName: 'deck.pdf', mimeType: 'application/pdf', content: Buffer.from('abc') },
    ])
  })

  it('should preserve the caller ordering rather than the database ordering', async () => {
    getActiveResourcesByIdsMock.mockResolvedValue([
      { id: 'r2', file_name: 'b.pdf', mime_type: 'application/pdf', byte_size: 1, storage_path: 'p2' },
      { id: 'r1', file_name: 'a.pdf', mime_type: 'application/pdf', byte_size: 1, storage_path: 'p1' },
    ])
    downloadClientResourceMock.mockResolvedValue(Buffer.from('x'))

    const result = await loadResourceAttachments(supabase, 'c1', ['r1', 'r2'])
    expect(result.map((a) => a.fileName)).toEqual(['a.pdf', 'b.pdf'])
  })

  it('should throw NOT_FOUND for an id that did not resolve for this client', async () => {
    getActiveResourcesByIdsMock.mockResolvedValue([])
    await expect(loadResourceAttachments(supabase, 'c1', ['r-foreign'])).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
    expect(downloadClientResourceMock).not.toHaveBeenCalled()
  })

  it('should throw rather than send a short set when one id was soft-deleted', async () => {
    getActiveResourcesByIdsMock.mockResolvedValue([
      { id: 'r1', file_name: 'a.pdf', mime_type: 'application/pdf', byte_size: 1, storage_path: 'p1' },
    ])

    await expect(loadResourceAttachments(supabase, 'c1', ['r1', 'r2'])).rejects.toMatchObject({
      code: 'NOT_FOUND',
      context: { missingResourceIds: ['r2'] },
    })
    expect(downloadClientResourceMock).not.toHaveBeenCalled()
  })

  it('should propagate a download failure rather than sending a partial set', async () => {
    getActiveResourcesByIdsMock.mockResolvedValue([
      { id: 'r1', file_name: 'a.pdf', mime_type: 'application/pdf', byte_size: 1, storage_path: 'p1' },
    ])
    downloadClientResourceMock.mockRejectedValue(new Error('gone'))
    await expect(loadResourceAttachments(supabase, 'c1', ['r1'])).rejects.toThrow('gone')
  })

  it('should throw VALIDATION_ERROR when the resolved set breaches the byte budget', async () => {
    getActiveResourcesByIdsMock.mockResolvedValue([
      { id: 'r1', file_name: 'a.pdf', mime_type: 'application/pdf', byte_size: 1, storage_path: 'p1' },
    ])
    downloadClientResourceMock.mockResolvedValue(Buffer.alloc(4 * 1024 * 1024))
    await expect(loadResourceAttachments(supabase, 'c1', ['r1'])).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    })
  })
})
