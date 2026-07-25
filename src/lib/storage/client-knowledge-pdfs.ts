import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { AppError } from '@/lib/errors/app-error'

export const KNOWLEDGE_PDF_BUCKET = 'client-knowledge-pdfs'
export const KNOWLEDGE_PDF_MAX_BYTES = 10 * 1024 * 1024 // 10MB
// Private bucket (unlike client-logos) — signed URLs only, since a client's
// uploaded PDF may contain sensitive business content.
const SIGNED_URL_EXPIRY_SECONDS = 3600

export function assertValidPdfFile(file: File): void {
  if (file.type !== 'application/pdf') {
    throw new AppError('VALIDATION_ERROR', 'File must be a PDF', { contentType: file.type })
  }
  if (file.size > KNOWLEDGE_PDF_MAX_BYTES) {
    throw new AppError('VALIDATION_ERROR', 'PDF must be 10MB or smaller', { size: file.size })
  }
}

export async function uploadClientKnowledgePdf(
  supabase: SupabaseClient<Database>,
  clientId: string,
  file: File,
): Promise<string> {
  assertValidPdfFile(file)
  const path = `${clientId}/${randomUUID()}.pdf`
  const { error } = await supabase.storage.from(KNOWLEDGE_PDF_BUCKET).upload(path, file, {
    contentType: 'application/pdf',
    cacheControl: '3600',
    upsert: false,
  })
  if (error) {
    throw new AppError('EXTERNAL_ERROR', 'Failed to upload PDF', { clientId, cause: error.message })
  }
  return path
}

// Best-effort cleanup, same convention as deleteClientLogoObject — called
// after the DB row is already deleted, must never fail the request.
export async function deleteClientKnowledgePdfObject(
  supabase: SupabaseClient<Database>,
  storagePath: string,
): Promise<void> {
  try {
    await supabase.storage.from(KNOWLEDGE_PDF_BUCKET).remove([storagePath])
  } catch {
    // Best-effort — see function comment.
  }
}

export async function getClientKnowledgePdfSignedUrl(
  supabase: SupabaseClient<Database>,
  storagePath: string,
): Promise<string> {
  const { data, error } = await supabase.storage
    .from(KNOWLEDGE_PDF_BUCKET)
    .createSignedUrl(storagePath, SIGNED_URL_EXPIRY_SECONDS)
  if (error || !data) {
    throw new AppError('EXTERNAL_ERROR', 'Failed to sign PDF url', { storagePath, cause: error?.message })
  }
  return data.signedUrl
}
