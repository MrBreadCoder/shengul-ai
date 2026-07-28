import { AppError } from '@/lib/errors/app-error'

export interface EmailAttachment {
  fileName: string
  mimeType: string
  content: Buffer
}

// Ceiling chosen so every provider stays on its simple send path: Gmail raw
// MIME, a single Graph sendMail call, one nodemailer message. Going past ~3MB
// forces Graph into createUploadSession against a draft, which is a materially
// different send with its own retry semantics.
export const MAX_ATTACHMENTS_PER_EMAIL = 3
export const MAX_TOTAL_ATTACHMENT_BYTES = 3 * 1024 * 1024

// Long enough for any real filename, short enough that a hostile upload cannot
// bloat a MIME header.
const MAX_FILE_NAME_LENGTH = 120

/**
 * Reduces an uploaded filename to something safe to interpolate into a MIME
 * `Content-Disposition` header. Run once at upload time so the stored
 * `client_resources.file_name` is already wire-safe and no send path has to
 * re-check. NFKD decomposes accented characters so 'é' degrades to 'e' rather
 * than vanishing.
 */
export function sanitizeAttachmentFileName(name: string): string {
  // safe: String.split always returns at least one element, so pop() is never
  // undefined here — a `?? ''` fallback would be a permanently unreachable branch.
  const base = name.split(/[/\\]/).pop()!
  // Drops CR/LF (the header-injection vector) and every combining mark NFKD
  // just split off, in one pass — both are outside printable ASCII.
  const ascii = base.normalize('NFKD').replace(/[^ -~]/g, '')
  const safe = ascii.replace(/["';]/g, '').trim()
  const truncated = safe.slice(0, MAX_FILE_NAME_LENGTH)
  return truncated.length > 0 ? truncated : 'attachment'
}

export function assertWithinAttachmentLimits(attachments: readonly EmailAttachment[]): void {
  if (attachments.length > MAX_ATTACHMENTS_PER_EMAIL) {
    throw new AppError(
      'VALIDATION_ERROR',
      `An email may carry at most ${MAX_ATTACHMENTS_PER_EMAIL} attachments`,
      { count: attachments.length },
    )
  }
  const totalBytes = attachments.reduce((sum, a) => sum + a.content.byteLength, 0)
  if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
    throw new AppError(
      'VALIDATION_ERROR',
      'Attachments exceed the 3MB per-email limit',
      { totalBytes, limitBytes: MAX_TOTAL_ATTACHMENT_BYTES },
    )
  }
}
