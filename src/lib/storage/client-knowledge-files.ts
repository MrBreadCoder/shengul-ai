import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { AppError } from '@/lib/errors/app-error'
import { sanitizeAttachmentFileName } from '@/lib/mailbox/attachments'
import { extractPdfText } from '@/lib/knowledge/pdf-extract'

// Bucket id stays 'client-knowledge-pdfs' even though it now holds .txt and .md
// too — renaming a Supabase storage bucket means migrating every existing
// object, which buys nothing.
export const KNOWLEDGE_FILE_BUCKET = 'client-knowledge-pdfs'
export const KNOWLEDGE_FILE_MAX_BYTES = 10 * 1024 * 1024 // 10MB
// Text-bearing formats only. Images belong in client_resources — a resource is
// something to send, not something to answer from.
export const ALLOWED_KNOWLEDGE_MIME_TYPES: readonly string[] = [
  'application/pdf',
  'text/plain',
  'text/markdown',
]
// Private bucket (unlike client-logos) — signed URLs only, since a client's
// uploaded file may contain sensitive business content.
const SIGNED_URL_EXPIRY_SECONDS = 3600

export function assertValidKnowledgeFile(file: File): void {
  if (!ALLOWED_KNOWLEDGE_MIME_TYPES.includes(file.type)) {
    throw new AppError('VALIDATION_ERROR', 'File must be a PDF, .txt or .md', {
      contentType: file.type,
    })
  }
  if (file.size === 0) {
    throw new AppError('VALIDATION_ERROR', 'File is empty', { size: file.size })
  }
  if (file.size > KNOWLEDGE_FILE_MAX_BYTES) {
    throw new AppError('VALIDATION_ERROR', 'File must be 10MB or smaller', { size: file.size })
  }
}

// A .txt/.md file is already text — running it through the PDF extractor would
// fail. Branching here keeps the route a single code path.
export async function extractKnowledgeText(file: File): Promise<string> {
  if (file.type === 'application/pdf') {
    return extractPdfText(await file.arrayBuffer())
  }
  return file.text()
}

export async function uploadClientKnowledgeFile(
  supabase: SupabaseClient<Database>,
  clientId: string,
  file: File,
): Promise<string> {
  assertValidKnowledgeFile(file)
  // Extension taken from the sanitized name, matching uploadClientResource: the
  // raw upload name is attacker-controlled and path.extname happily returns
  // whitespace or control characters, which have no business in a storage key.
  const storagePath = `${clientId}/${randomUUID()}${path.extname(sanitizeAttachmentFileName(file.name))}`
  const { error } = await supabase.storage.from(KNOWLEDGE_FILE_BUCKET).upload(storagePath, file, {
    contentType: file.type,
    cacheControl: '3600',
    upsert: false,
  })
  if (error) {
    throw new AppError('EXTERNAL_ERROR', 'Failed to upload knowledge file', {
      clientId, cause: error.message,
    })
  }
  return storagePath
}

// Best-effort cleanup, same convention as deleteClientLogoObject — called
// after the DB row is already deleted, must never fail the request.
export async function deleteClientKnowledgeFileObject(
  supabase: SupabaseClient<Database>,
  storagePath: string,
): Promise<void> {
  try {
    await supabase.storage.from(KNOWLEDGE_FILE_BUCKET).remove([storagePath])
  } catch {
    // Best-effort — see function comment.
  }
}

export async function getClientKnowledgeFileSignedUrl(
  supabase: SupabaseClient<Database>,
  storagePath: string,
): Promise<string> {
  const { data, error } = await supabase.storage
    .from(KNOWLEDGE_FILE_BUCKET)
    .createSignedUrl(storagePath, SIGNED_URL_EXPIRY_SECONDS)
  if (error || !data) {
    throw new AppError('EXTERNAL_ERROR', 'Failed to sign knowledge file url', {
      storagePath, cause: error?.message,
    })
  }
  return data.signedUrl
}
