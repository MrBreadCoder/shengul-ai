import { describe, it, expect, vi } from 'vitest'
import { AppError } from '@/lib/errors/app-error'

const extractPdfTextMock = vi.fn()
vi.mock('@/lib/knowledge/pdf-extract', () => ({
  extractPdfText: (...a: unknown[]) => extractPdfTextMock(...a),
}))

import {
  KNOWLEDGE_FILE_BUCKET,
  KNOWLEDGE_FILE_MAX_BYTES,
  assertValidKnowledgeFile,
  extractKnowledgeText,
  uploadClientKnowledgeFile,
  deleteClientKnowledgeFileObject,
  getClientKnowledgeFileSignedUrl,
} from './client-knowledge-files'

function knowledgeFile(name: string, size: number, type = 'application/pdf'): File {
  return { name, size, type } as File
}

describe('assertValidKnowledgeFile', () => {
  it('should not throw for a valid pdf under the size limit', () => {
    expect(() => assertValidKnowledgeFile(knowledgeFile('doc.pdf', 1000))).not.toThrow()
  })

  it('should accept pdf, plain text and markdown', () => {
    for (const type of ['application/pdf', 'text/plain', 'text/markdown']) {
      expect(() => assertValidKnowledgeFile(knowledgeFile('f', 10, type))).not.toThrow()
    }
  })

  it('should reject an image, which belongs in resources not knowledge', () => {
    try {
      assertValidKnowledgeFile(knowledgeFile('a.png', 10, 'image/png'))
      expect.unreachable('should have thrown')
    } catch (error) {
      expect((error as AppError).code).toBe('VALIDATION_ERROR')
    }
  })

  it('should throw VALIDATION_ERROR when the file is empty', () => {
    try {
      assertValidKnowledgeFile(knowledgeFile('doc.pdf', 0))
      expect.unreachable('should have thrown')
    } catch (error) {
      expect((error as AppError).code).toBe('VALIDATION_ERROR')
    }
  })

  it('should throw VALIDATION_ERROR when the file exceeds the size cap', () => {
    expect(() => assertValidKnowledgeFile(knowledgeFile('doc.pdf', KNOWLEDGE_FILE_MAX_BYTES + 1))).toThrow(AppError)
  })
})

describe('extractKnowledgeText', () => {
  it('should decode a text file directly without invoking the pdf extractor', async () => {
    const file = new File(['hello world'], 'a.txt', { type: 'text/plain' })
    await expect(extractKnowledgeText(file)).resolves.toBe('hello world')
    expect(extractPdfTextMock).not.toHaveBeenCalled()
  })

  it('should decode a markdown file directly', async () => {
    const file = new File(['# Title'], 'a.md', { type: 'text/markdown' })
    await expect(extractKnowledgeText(file)).resolves.toBe('# Title')
  })

  it('should route a pdf through the pdf extractor', async () => {
    extractPdfTextMock.mockResolvedValue('pdf text')
    const file = new File(['%PDF'], 'a.pdf', { type: 'application/pdf' })
    await expect(extractKnowledgeText(file)).resolves.toBe('pdf text')
    expect(extractPdfTextMock).toHaveBeenCalled()
  })
})

describe('uploadClientKnowledgeFile', () => {
  it('should upload to a fresh per-call path and return it', async () => {
    const uploadMock = vi.fn().mockResolvedValue({ error: null })
    const supabase = { storage: { from: () => ({ upload: uploadMock }) } } as never
    const path = await uploadClientKnowledgeFile(supabase, 'client-1', knowledgeFile('doc.pdf', 1000))
    expect(path).toMatch(/^client-1\/[0-9a-f-]+\.pdf$/)
    expect(uploadMock).toHaveBeenCalledWith(path, expect.anything(), expect.objectContaining({ contentType: 'application/pdf' }))
  })

  it('should keep the uploaded extension when the file is markdown', async () => {
    const uploadMock = vi.fn().mockResolvedValue({ error: null })
    const supabase = { storage: { from: () => ({ upload: uploadMock }) } } as never
    const path = await uploadClientKnowledgeFile(supabase, 'client-1', knowledgeFile('notes.md', 100, 'text/markdown'))
    expect(path).toMatch(/^client-1\/[0-9a-f-]+\.md$/)
    expect(uploadMock).toHaveBeenCalledWith(path, expect.anything(), expect.objectContaining({ contentType: 'text/markdown' }))
  })

  it('should take the extension from the sanitized name, not the raw upload name', async () => {
    const uploadMock = vi.fn().mockResolvedValue({ error: null })
    const supabase = { storage: { from: () => ({ upload: uploadMock }) } } as never

    const path = await uploadClientKnowledgeFile(
      supabase,
      'client-1',
      knowledgeFile('../../evil/notes.p df\r\n', 100, 'text/plain'),
    )

    expect(path).toMatch(/^client-1\/[0-9a-f-]+\.[ -~]*$/)
    expect(path).not.toContain('..')
    expect(path).not.toMatch(/[\r\n]/)
  })

  it('should throw EXTERNAL_ERROR when the upload fails', async () => {
    const supabase = { storage: { from: () => ({ upload: vi.fn().mockResolvedValue({ error: { message: 'boom' } }) }) } } as never
    await expect(uploadClientKnowledgeFile(supabase, 'client-1', knowledgeFile('doc.pdf', 1000))).rejects.toMatchObject({
      code: 'EXTERNAL_ERROR',
    })
  })
})

describe('deleteClientKnowledgeFileObject', () => {
  it('should remove the object at the given path', async () => {
    const removeMock = vi.fn().mockResolvedValue({ error: null })
    const supabase = { storage: { from: () => ({ remove: removeMock }) } } as never
    await deleteClientKnowledgeFileObject(supabase, 'client-1/abc.pdf')
    expect(removeMock).toHaveBeenCalledWith(['client-1/abc.pdf'])
  })

  it('should swallow storage errors (best-effort cleanup)', async () => {
    const supabase = { storage: { from: () => ({ remove: vi.fn().mockRejectedValue(new Error('gone')) }) } } as never
    await expect(deleteClientKnowledgeFileObject(supabase, 'client-1/abc.pdf')).resolves.toBeUndefined()
  })
})

describe('getClientKnowledgeFileSignedUrl', () => {
  it('should return the signed url', async () => {
    const supabase = {
      storage: { from: () => ({ createSignedUrl: vi.fn().mockResolvedValue({ data: { signedUrl: 'https://x/signed' }, error: null }) }) },
    } as never
    const url = await getClientKnowledgeFileSignedUrl(supabase, 'client-1/abc.pdf')
    expect(url).toBe('https://x/signed')
  })

  it('should throw EXTERNAL_ERROR when signing fails', async () => {
    const supabase = {
      storage: { from: () => ({ createSignedUrl: vi.fn().mockResolvedValue({ data: null, error: { message: 'boom' } }) }) },
    } as never
    await expect(getClientKnowledgeFileSignedUrl(supabase, 'client-1/abc.pdf')).rejects.toMatchObject({
      code: 'EXTERNAL_ERROR',
    })
  })
})

describe('KNOWLEDGE_FILE_BUCKET', () => {
  it('should be the client-knowledge-pdfs bucket id', () => {
    expect(KNOWLEDGE_FILE_BUCKET).toBe('client-knowledge-pdfs')
  })
})
