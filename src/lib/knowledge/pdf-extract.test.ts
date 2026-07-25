import { describe, it, expect, vi } from 'vitest'

const getDocumentProxyMock = vi.fn()
const extractTextMock = vi.fn()
vi.mock('unpdf', () => ({
  getDocumentProxy: (...a: unknown[]) => getDocumentProxyMock(...a),
  extractText: (...a: unknown[]) => extractTextMock(...a),
}))

import { extractPdfText, PDF_MAX_EXTRACTED_CHARS } from './pdf-extract'
import { AppError } from '@/lib/errors/app-error'

describe('extractPdfText', () => {
  it('should return the merged text from the pdf', async () => {
    getDocumentProxyMock.mockResolvedValue({ id: 'doc' })
    extractTextMock.mockResolvedValue({ text: 'Hello from the PDF' })
    const result = await extractPdfText(new ArrayBuffer(4))
    expect(result).toBe('Hello from the PDF')
    expect(extractTextMock).toHaveBeenCalledWith({ id: 'doc' }, { mergePages: true })
  })

  it('should truncate text longer than PDF_MAX_EXTRACTED_CHARS', async () => {
    getDocumentProxyMock.mockResolvedValue({ id: 'doc' })
    extractTextMock.mockResolvedValue({ text: 'x'.repeat(PDF_MAX_EXTRACTED_CHARS + 500) })
    const result = await extractPdfText(new ArrayBuffer(4))
    expect(result.length).toBe(PDF_MAX_EXTRACTED_CHARS)
  })

  it('should throw AppError VALIDATION_ERROR when parsing fails', async () => {
    getDocumentProxyMock.mockRejectedValue(new Error('not a pdf'))
    await expect(extractPdfText(new ArrayBuffer(4))).rejects.toBeInstanceOf(AppError)
    await expect(extractPdfText(new ArrayBuffer(4))).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
  })
})
