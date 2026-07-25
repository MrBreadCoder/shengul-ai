import { describe, it, expect, vi } from 'vitest'
import { AppError } from '@/lib/errors/app-error'
import {
  KNOWLEDGE_PDF_BUCKET,
  KNOWLEDGE_PDF_MAX_BYTES,
  assertValidPdfFile,
  uploadClientKnowledgePdf,
  deleteClientKnowledgePdfObject,
  getClientKnowledgePdfSignedUrl,
} from './client-knowledge-pdfs'

function pdfFile(name: string, size: number, type = 'application/pdf'): File {
  return { name, size, type } as File
}

describe('assertValidPdfFile', () => {
  it('should not throw for a valid pdf under the size limit', () => {
    expect(() => assertValidPdfFile(pdfFile('doc.pdf', 1000))).not.toThrow()
  })

  it('should throw VALIDATION_ERROR for a non-pdf mime type', () => {
    expect(() => assertValidPdfFile(pdfFile('doc.png', 1000, 'image/png'))).toThrow(AppError)
  })

  it('should throw VALIDATION_ERROR when the file exceeds the size cap', () => {
    expect(() => assertValidPdfFile(pdfFile('doc.pdf', KNOWLEDGE_PDF_MAX_BYTES + 1))).toThrow(AppError)
  })
})

describe('uploadClientKnowledgePdf', () => {
  it('should upload to a fresh per-call path and return it', async () => {
    const uploadMock = vi.fn().mockResolvedValue({ error: null })
    const supabase = { storage: { from: () => ({ upload: uploadMock }) } } as never
    const path = await uploadClientKnowledgePdf(supabase, 'client-1', pdfFile('doc.pdf', 1000))
    expect(path).toMatch(/^client-1\/[0-9a-f-]+\.pdf$/)
    expect(uploadMock).toHaveBeenCalledWith(path, expect.anything(), expect.objectContaining({ contentType: 'application/pdf' }))
  })

  it('should throw EXTERNAL_ERROR when the upload fails', async () => {
    const supabase = { storage: { from: () => ({ upload: vi.fn().mockResolvedValue({ error: { message: 'boom' } }) }) } } as never
    await expect(uploadClientKnowledgePdf(supabase, 'client-1', pdfFile('doc.pdf', 1000))).rejects.toMatchObject({
      code: 'EXTERNAL_ERROR',
    })
  })
})

describe('deleteClientKnowledgePdfObject', () => {
  it('should remove the object at the given path', async () => {
    const removeMock = vi.fn().mockResolvedValue({ error: null })
    const supabase = { storage: { from: () => ({ remove: removeMock }) } } as never
    await deleteClientKnowledgePdfObject(supabase, 'client-1/abc.pdf')
    expect(removeMock).toHaveBeenCalledWith(['client-1/abc.pdf'])
  })

  it('should swallow storage errors (best-effort cleanup)', async () => {
    const supabase = { storage: { from: () => ({ remove: vi.fn().mockRejectedValue(new Error('gone')) }) } } as never
    await expect(deleteClientKnowledgePdfObject(supabase, 'client-1/abc.pdf')).resolves.toBeUndefined()
  })
})

describe('getClientKnowledgePdfSignedUrl', () => {
  it('should return the signed url', async () => {
    const supabase = {
      storage: { from: () => ({ createSignedUrl: vi.fn().mockResolvedValue({ data: { signedUrl: 'https://x/signed' }, error: null }) }) },
    } as never
    const url = await getClientKnowledgePdfSignedUrl(supabase, 'client-1/abc.pdf')
    expect(url).toBe('https://x/signed')
  })

  it('should throw EXTERNAL_ERROR when signing fails', async () => {
    const supabase = {
      storage: { from: () => ({ createSignedUrl: vi.fn().mockResolvedValue({ data: null, error: { message: 'boom' } }) }) },
    } as never
    await expect(getClientKnowledgePdfSignedUrl(supabase, 'client-1/abc.pdf')).rejects.toMatchObject({
      code: 'EXTERNAL_ERROR',
    })
  })
})

describe('KNOWLEDGE_PDF_BUCKET', () => {
  it('should be the client-knowledge-pdfs bucket id', () => {
    expect(KNOWLEDGE_PDF_BUCKET).toBe('client-knowledge-pdfs')
  })
})
