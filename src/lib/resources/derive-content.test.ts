import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { z } from 'zod'
import type { ClientResourceRow } from '@/lib/db/client-resources'
import { AppError } from '@/lib/errors/app-error'
import { RESOURCE_CONTENT_MAX_CHARS } from './read-strategy'
import { RESOURCE_SUMMARY_MAX_CHARS } from './menu'

const downloadClientResourceMock = vi.fn()
const extractPdfTextMock = vi.fn()
const generateJsonMock = vi.fn()

vi.mock('@/lib/storage/client-resources', () => ({
  downloadClientResource: (...a: unknown[]) => downloadClientResourceMock(...a),
}))
vi.mock('@/lib/knowledge/pdf-extract', () => ({
  extractPdfText: (...a: unknown[]) => extractPdfTextMock(...a),
}))
vi.mock('@/lib/llm/client', () => ({ generateJson: (...a: unknown[]) => generateJsonMock(...a) }))

import { readResourceContent } from './derive-content'

function resource(overrides: Partial<ClientResourceRow> = {}): ClientResourceRow {
  return {
    id: 'r1', client_id: 'c1', title: 'Deck', description: 'on request',
    file_name: 'deck.pdf', mime_type: 'application/pdf', byte_size: 100,
    storage_path: 'c1/deck.pdf', is_active: true, content_status: 'pending',
    content: null, content_summary: null, content_error: null, read_at: null,
    created_by: 'u1', created_at: '2026-07-26T00:00:00Z',
    ...overrides,
  }
}

beforeEach(() => {
  downloadClientResourceMock.mockReset().mockResolvedValue(Buffer.from('plain file body'))
  extractPdfTextMock.mockReset()
  generateJsonMock.mockReset()
})

describe('readResourceContent', () => {
  it('should use the decoded bytes as content and ask only for a summary when the file is text', async () => {
    downloadClientResourceMock.mockResolvedValue(Buffer.from('Our rate card starts at 2500 EUR'))
    generateJsonMock.mockResolvedValue({ summary: 'Rate card from 2500 EUR' })

    const result = await readResourceContent({} as never, resource({ mime_type: 'text/plain' }))

    expect(result).toEqual({
      status: 'ready',
      content: 'Our rate card starts at 2500 EUR',
      summary: 'Rate card from 2500 EUR',
    })
    expect(generateJsonMock.mock.calls[0]?.[1]).not.toHaveProperty('files')
    expect(extractPdfTextMock).not.toHaveBeenCalled()
  })

  it('should use the extracted text when a pdf has a usable text layer', async () => {
    extractPdfTextMock.mockResolvedValue('b'.repeat(500))
    generateJsonMock.mockResolvedValue({ summary: 'A long document' })

    const result = await readResourceContent({} as never, resource())

    expect(result).toEqual({ status: 'ready', content: 'b'.repeat(500), summary: 'A long document' })
    expect(generateJsonMock.mock.calls[0]?.[1]).not.toHaveProperty('files')
  })

  it('should attach the pdf bytes to the model when the text layer is too thin', async () => {
    const bytes = Buffer.from('%PDF-1.7 image only')
    downloadClientResourceMock.mockResolvedValue(bytes)
    extractPdfTextMock.mockResolvedValue('  1  ')
    generateJsonMock.mockResolvedValue({ content: '12 brand projects', summary: '12 brand projects' })

    const result = await readResourceContent({} as never, resource())

    expect(result).toEqual({ status: 'ready', content: '12 brand projects', summary: '12 brand projects' })
    expect(generateJsonMock.mock.calls[0]?.[1]).toMatchObject({
      files: [{ data: bytes, mediaType: 'application/pdf' }],
    })
  })

  it('should fall back to vision when pdf extraction throws on a malformed file', async () => {
    downloadClientResourceMock.mockResolvedValue(Buffer.from('broken'))
    extractPdfTextMock.mockRejectedValue(new AppError('VALIDATION_ERROR', 'Could not extract text'))
    generateJsonMock.mockResolvedValue({ content: 'A scanned invoice', summary: 'A scanned invoice' })

    const result = await readResourceContent({} as never, resource())

    expect(result).toEqual({ status: 'ready', content: 'A scanned invoice', summary: 'A scanned invoice' })
  })

  it('should attach an image to the model rather than decoding its bytes', async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47])
    downloadClientResourceMock.mockResolvedValue(bytes)
    generateJsonMock.mockResolvedValue({ content: 'A dark navy logo mark', summary: 'Navy logo mark' })

    const result = await readResourceContent({} as never, resource({ mime_type: 'image/png' }))

    expect(result).toEqual({ status: 'ready', content: 'A dark navy logo mark', summary: 'Navy logo mark' })
    expect(generateJsonMock.mock.calls[0]?.[1]).toMatchObject({
      files: [{ data: bytes, mediaType: 'image/png' }],
    })
  })

  it('should report unsupported without downloading or calling the model for a gif', async () => {
    const result = await readResourceContent({} as never, resource({ mime_type: 'image/gif' }))

    expect(result).toEqual({ status: 'unsupported' })
    expect(downloadClientResourceMock).not.toHaveBeenCalled()
    expect(generateJsonMock).not.toHaveBeenCalled()
  })

  it('should truncate content and summary to their caps', async () => {
    downloadClientResourceMock.mockResolvedValue(Buffer.from('x'.repeat(RESOURCE_CONTENT_MAX_CHARS + 500)))
    generateJsonMock.mockResolvedValue({ summary: 'y'.repeat(RESOURCE_SUMMARY_MAX_CHARS + 50) })

    const result = await readResourceContent({} as never, resource({ mime_type: 'text/plain' }))

    expect(result).toEqual({
      status: 'ready',
      content: 'x'.repeat(RESOURCE_CONTENT_MAX_CHARS),
      summary: 'y'.repeat(RESOURCE_SUMMARY_MAX_CHARS),
    })
  })

  it('should throw VALIDATION_ERROR when a text file decodes to nothing readable', async () => {
    downloadClientResourceMock.mockResolvedValue(Buffer.from('   \n\t  '))

    await expect(
      readResourceContent({} as never, resource({ mime_type: 'text/markdown' })),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(generateJsonMock).not.toHaveBeenCalled()
  })

  // generateJson hands the schema to the SDK, which validates the model's JSON
  // against it. Mirrored here so these exercise the real schema rather than a
  // mock's idea of one.
  const parseModelOutput = (output: unknown) => (
    (_context: unknown, args: { schema: z.ZodType }) => Promise.resolve(args.schema.parse(output))
  )

  it('should reject a whitespace-only summary on the text path', async () => {
    downloadClientResourceMock.mockResolvedValue(Buffer.from('Our rate card starts at 2500 EUR'))
    generateJsonMock.mockImplementation(parseModelOutput({ summary: '  \n\t ' }))

    await expect(
      readResourceContent({} as never, resource({ mime_type: 'text/plain' })),
    ).rejects.toThrow()
  })

  it('should reject whitespace-only content on the vision path', async () => {
    downloadClientResourceMock.mockResolvedValue(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    generateJsonMock.mockImplementation(parseModelOutput({ content: '   ', summary: 'Navy logo mark' }))

    await expect(
      readResourceContent({} as never, resource({ mime_type: 'image/png' })),
    ).rejects.toThrow()
  })

  it('should reject a whitespace-only summary on the vision path', async () => {
    downloadClientResourceMock.mockResolvedValue(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    generateJsonMock.mockImplementation(parseModelOutput({ content: 'A dark navy logo mark', summary: ' ' }))

    await expect(
      readResourceContent({} as never, resource({ mime_type: 'image/png' })),
    ).rejects.toThrow()
  })

  it('should keep a padded summary once trimmed rather than rejecting it', async () => {
    downloadClientResourceMock.mockResolvedValue(Buffer.from('Our rate card starts at 2500 EUR'))
    generateJsonMock.mockImplementation(parseModelOutput({ summary: '  Rate card from 2500 EUR  ' }))

    const result = await readResourceContent({} as never, resource({ mime_type: 'text/plain' }))

    expect(result).toMatchObject({ status: 'ready', summary: 'Rate card from 2500 EUR' })
  })

  it('should let an LLM failure propagate so the worker can record it', async () => {
    downloadClientResourceMock.mockResolvedValue(Buffer.from('readable body'))
    generateJsonMock.mockRejectedValue(new AppError('EXTERNAL_TIMEOUT', 'LLM call timed out'))

    await expect(
      readResourceContent({} as never, resource({ mime_type: 'text/plain' })),
    ).rejects.toMatchObject({ code: 'EXTERNAL_TIMEOUT' })
  })
})
