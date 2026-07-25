import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { AppError } from '@/lib/errors/app-error'

export const LOGO_BUCKET = 'client-logos'
export const LOGO_MAX_BYTES = 2 * 1024 * 1024 // 2MB — generous for a logo, blocks accidental huge uploads

const LOGO_MIME_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
}

// Validates type and size before the file touches storage. Message is safe to
// show the operator directly.
export function assertValidLogoFile(file: File): string {
  const extension = LOGO_MIME_EXTENSIONS[file.type]
  if (!extension) {
    throw new AppError('VALIDATION_ERROR', 'Logo must be a PNG, JPEG, WebP, or SVG image', {
      contentType: file.type,
    })
  }
  if (file.size > LOGO_MAX_BYTES) {
    throw new AppError('VALIDATION_ERROR', 'Logo must be 2MB or smaller', { size: file.size })
  }
  return extension
}

// Uploads to a fresh path per call (rather than overwriting the client's existing
// object) so a replaced logo gets a new URL and never serves a stale cached image.
export async function uploadClientLogo(
  supabase: SupabaseClient<Database>,
  clientId: string,
  file: File,
): Promise<string> {
  const extension = assertValidLogoFile(file)
  const path = `${clientId}/${randomUUID()}.${extension}`
  const { error } = await supabase.storage.from(LOGO_BUCKET).upload(path, file, {
    contentType: file.type,
    cacheControl: '31536000',
    upsert: false,
  })
  if (error) throw new AppError('EXTERNAL_ERROR', 'Failed to upload logo', { clientId, cause: error.message })

  const { data } = supabase.storage.from(LOGO_BUCKET).getPublicUrl(path)
  return data.publicUrl
}

// Best-effort cleanup of the object behind a previously stored logo_url, called
// after a replace/remove has already committed the DB write — a storage-side
// failure here must never fail the request.
export async function deleteClientLogoObject(supabase: SupabaseClient<Database>, logoUrl: string): Promise<void> {
  const marker = `/object/public/${LOGO_BUCKET}/`
  const index = logoUrl.indexOf(marker)
  if (index === -1) return
  const path = logoUrl.slice(index + marker.length)
  if (!path) return

  try {
    await supabase.storage.from(LOGO_BUCKET).remove([path])
  } catch {
    // Best-effort — see function comment.
  }
}
