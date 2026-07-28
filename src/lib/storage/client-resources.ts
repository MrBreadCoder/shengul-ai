import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { AppError } from '@/lib/errors/app-error'
import { sanitizeAttachmentFileName } from '@/lib/mailbox/attachments'

export const RESOURCE_BUCKET = 'client-resources'
// Matches MAX_TOTAL_ATTACHMENT_BYTES: a single resource can never be too big to
// send on its own, so an operator cannot upload something unsendable.
export const RESOURCE_MAX_BYTES = 3 * 1024 * 1024
export const ALLOWED_RESOURCE_MIME_TYPES: readonly string[] = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'text/plain',
  'text/markdown',
]
// Private bucket — a resource may be unreleased client collateral, so reads go
// through a short-lived signed URL rather than a public URL.
const SIGNED_URL_EXPIRY_SECONDS = 3600

export function assertValidResourceFile(file: File): void {
  if (!ALLOWED_RESOURCE_MIME_TYPES.includes(file.type)) {
    throw new AppError('VALIDATION_ERROR', 'Unsupported file type', { contentType: file.type })
  }
  if (file.size === 0) {
    throw new AppError('VALIDATION_ERROR', 'File is empty', { size: file.size })
  }
  if (file.size > RESOURCE_MAX_BYTES) {
    throw new AppError('VALIDATION_ERROR', 'File must be 3MB or smaller', { size: file.size })
  }
}

export async function uploadClientResource(
  supabase: SupabaseClient<Database>,
  clientId: string,
  file: File,
): Promise<{ storagePath: string; fileName: string }> {
  assertValidResourceFile(file)
  const fileName = sanitizeAttachmentFileName(file.name)
  // The stored object name is a uuid, not the display name: two clients
  // uploading 'portfolio.pdf' must not collide, and the display name is
  // already carried on the row.
  const storagePath = `${clientId}/${randomUUID()}${path.extname(fileName)}`
  const { error } = await supabase.storage.from(RESOURCE_BUCKET).upload(storagePath, file, {
    contentType: file.type,
    cacheControl: '3600',
    upsert: false,
  })
  if (error) {
    throw new AppError('EXTERNAL_ERROR', 'Failed to upload resource', { clientId, cause: error.message })
  }
  return { storagePath, fileName }
}

export async function downloadClientResource(
  supabase: SupabaseClient<Database>,
  storagePath: string,
): Promise<Buffer> {
  const { data, error } = await supabase.storage.from(RESOURCE_BUCKET).download(storagePath)
  if (error || !data) {
    throw new AppError('EXTERNAL_ERROR', 'Failed to download resource', {
      storagePath, cause: error?.message,
    })
  }
  return Buffer.from(await data.arrayBuffer())
}

// Best-effort cleanup, same convention as deleteClientKnowledgePdfObject —
// called after the row is already deactivated, must never fail the request.
export async function deleteClientResourceObject(
  supabase: SupabaseClient<Database>,
  storagePath: string,
): Promise<void> {
  try {
    await supabase.storage.from(RESOURCE_BUCKET).remove([storagePath])
  } catch {
    // Best-effort — see function comment.
  }
}

export async function getClientResourceSignedUrl(
  supabase: SupabaseClient<Database>,
  storagePath: string,
): Promise<string> {
  const { data, error } = await supabase.storage
    .from(RESOURCE_BUCKET)
    .createSignedUrl(storagePath, SIGNED_URL_EXPIRY_SECONDS)
  if (error || !data) {
    throw new AppError('EXTERNAL_ERROR', 'Failed to sign resource url', {
      storagePath, cause: error?.message,
    })
  }
  return data.signedUrl
}
