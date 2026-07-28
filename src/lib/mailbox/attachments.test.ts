import { describe, it, expect } from 'vitest'
import { AppError } from '@/lib/errors/app-error'
import {
  MAX_ATTACHMENTS_PER_EMAIL,
  MAX_TOTAL_ATTACHMENT_BYTES,
  sanitizeAttachmentFileName,
  assertWithinAttachmentLimits,
  type EmailAttachment,
} from './attachments'

function attachment(fileName: string, bytes: number): EmailAttachment {
  return { fileName, mimeType: 'application/pdf', content: Buffer.alloc(bytes) }
}

describe('sanitizeAttachmentFileName', () => {
  it('should strip directory components when the name looks like a path', () => {
    expect(sanitizeAttachmentFileName('../../etc/passwd')).toBe('passwd')
    expect(sanitizeAttachmentFileName('C:\\Users\\me\\deck.pdf')).toBe('deck.pdf')
  })

  it('should remove characters that would break a Content-Disposition header', () => {
    expect(sanitizeAttachmentFileName('a"b;c\r\nd.pdf')).toBe('abcd.pdf')
  })

  it('should fold non-ascii characters away when the name has accents', () => {
    expect(sanitizeAttachmentFileName('résumé.pdf')).toBe('resume.pdf')
  })

  it('should fall back to a generic name when nothing safe survives', () => {
    expect(sanitizeAttachmentFileName('日本語')).toBe('attachment')
    expect(sanitizeAttachmentFileName('   ')).toBe('attachment')
  })

  it('should truncate when the name is absurdly long', () => {
    const result = sanitizeAttachmentFileName(`${'a'.repeat(500)}.pdf`)
    expect(result.length).toBe(120)
  })
})

describe('assertWithinAttachmentLimits', () => {
  it('should pass when there are no attachments', () => {
    expect(() => assertWithinAttachmentLimits([])).not.toThrow()
  })

  it('should pass when exactly at both limits', () => {
    const each = Math.floor(MAX_TOTAL_ATTACHMENT_BYTES / MAX_ATTACHMENTS_PER_EMAIL)
    const attachments = Array.from({ length: MAX_ATTACHMENTS_PER_EMAIL }, (_, i) =>
      attachment(`f${i}.pdf`, each),
    )
    expect(() => assertWithinAttachmentLimits(attachments)).not.toThrow()
  })

  it('should throw VALIDATION_ERROR when there are too many files', () => {
    const attachments = Array.from({ length: MAX_ATTACHMENTS_PER_EMAIL + 1 }, (_, i) =>
      attachment(`f${i}.pdf`, 10),
    )
    try {
      assertWithinAttachmentLimits(attachments)
      expect.unreachable('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(AppError)
      expect((error as AppError).code).toBe('VALIDATION_ERROR')
      expect((error as AppError).context).toMatchObject({ count: MAX_ATTACHMENTS_PER_EMAIL + 1 })
    }
  })

  it('should throw VALIDATION_ERROR when the total exceeds the byte budget', () => {
    const attachments = [attachment('a.pdf', MAX_TOTAL_ATTACHMENT_BYTES), attachment('b.pdf', 1)]
    try {
      assertWithinAttachmentLimits(attachments)
      expect.unreachable('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(AppError)
      expect((error as AppError).code).toBe('VALIDATION_ERROR')
      expect((error as AppError).context).toMatchObject({
        totalBytes: MAX_TOTAL_ATTACHMENT_BYTES + 1,
      })
    }
  })
})
