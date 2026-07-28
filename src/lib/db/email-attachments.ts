import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { AppError } from '@/lib/errors/app-error'

export interface EmailAttachmentRow {
  resourceId: string
  title: string
  fileName: string
  mimeType: string
  byteSize: number
  storagePath: string
}

// The (email_id, resource_id) unique index plus ignoreDuplicates makes this
// idempotent: a retried QStash delivery re-attaching the same set is a no-op.
export async function insertEmailAttachments(
  supabase: SupabaseClient<Database>,
  input: { clientId: string; emailId: string; resourceIds: readonly string[] },
): Promise<void> {
  if (input.resourceIds.length === 0) return
  const { error } = await supabase.from('email_attachments').upsert(
    input.resourceIds.map((resourceId) => ({
      client_id: input.clientId,
      email_id: input.emailId,
      resource_id: resourceId,
    })),
    { onConflict: 'email_id,resource_id', ignoreDuplicates: true },
  )
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to attach resources to email', {
      emailId: input.emailId, cause: error.message,
    })
  }
}

interface JoinedAttachment {
  resource_id: string
  client_resources: {
    title: string
    file_name: string
    mime_type: string
    byte_size: number
    storage_path: string
  } | null
}

export async function listAttachmentsForEmail(
  supabase: SupabaseClient<Database>,
  emailId: string,
): Promise<EmailAttachmentRow[]> {
  const { data, error } = await supabase
    .from('email_attachments')
    .select('resource_id, client_resources(title, file_name, mime_type, byte_size, storage_path)')
    .eq('email_id', emailId)
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to list email attachments', { emailId, cause: error.message })
  }
  // A null join means the resource row is gone despite the RESTRICT FK, which
  // should be impossible — drop it rather than render a broken attachment.
  return ((data ?? []) as unknown as JoinedAttachment[])
    .filter(
      (row): row is JoinedAttachment & {
        client_resources: NonNullable<JoinedAttachment['client_resources']>
      } => row.client_resources !== null,
    )
    .map((row) => ({
      resourceId: row.resource_id,
      title: row.client_resources.title,
      fileName: row.client_resources.file_name,
      mimeType: row.client_resources.mime_type,
      byteSize: row.client_resources.byte_size,
      storagePath: row.client_resources.storage_path,
    }))
}

// Batched sibling of listAttachmentsForEmail for /inbox, which renders many
// drafts at once — one query plus an in-memory group, never one query per row.
export async function listAttachmentsForEmails(
  supabase: SupabaseClient<Database>,
  emailIds: readonly string[],
): Promise<Map<string, EmailAttachmentRow[]>> {
  if (emailIds.length === 0) return new Map()
  const { data, error } = await supabase
    .from('email_attachments')
    .select('email_id, resource_id, client_resources(title, file_name, mime_type, byte_size, storage_path)')
    .in('email_id', [...emailIds])
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to list email attachments', { cause: error.message })
  }

  const byEmailId = new Map<string, EmailAttachmentRow[]>()
  for (const row of (data ?? []) as unknown as (JoinedAttachment & { email_id: string })[]) {
    // A null join means the resource row is gone despite the RESTRICT FK, which
    // should be impossible — drop it rather than render a broken attachment.
    if (row.client_resources === null) continue
    const existing = byEmailId.get(row.email_id) ?? []
    existing.push({
      resourceId: row.resource_id,
      title: row.client_resources.title,
      fileName: row.client_resources.file_name,
      mimeType: row.client_resources.mime_type,
      byteSize: row.client_resources.byte_size,
      storagePath: row.client_resources.storage_path,
    })
    byEmailId.set(row.email_id, existing)
  }
  return byEmailId
}

// Used by the /inbox draft editor. Delete-then-insert rather than a diff: the
// set is at most MAX_ATTACHMENTS_PER_EMAIL rows and the email is still a draft,
// so nothing is reading it concurrently.
export async function replaceEmailAttachments(
  supabase: SupabaseClient<Database>,
  input: { clientId: string; emailId: string; resourceIds: readonly string[] },
): Promise<void> {
  const { error } = await supabase.from('email_attachments').delete().eq('email_id', input.emailId)
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to clear email attachments', {
      emailId: input.emailId, cause: error.message,
    })
  }
  await insertEmailAttachments(supabase, input)
}
