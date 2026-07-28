import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { AppError } from '@/lib/errors/app-error'

export interface MarkResourceContentReadyInput {
  resourceId: string
  content: string
  summary: string
}

export async function markResourceContentReady(
  supabase: SupabaseClient<Database>,
  input: MarkResourceContentReadyInput,
): Promise<void> {
  const { error } = await supabase
    .from('client_resources')
    .update({
      content_status: 'ready',
      content: input.content,
      content_summary: input.summary,
      content_error: null,
      read_at: new Date().toISOString(),
    })
    .eq('id', input.resourceId)
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to mark resource content ready', {
      resourceId: input.resourceId, cause: error.message,
    })
  }
}

// Derived fields are cleared alongside the status: a summary from an earlier
// successful read would otherwise keep reaching the AI's menu while the row
// reports that reading failed.
export async function markResourceContentFailed(
  supabase: SupabaseClient<Database>,
  resourceId: string,
  message: string,
): Promise<void> {
  const { error } = await supabase
    .from('client_resources')
    .update({
      content_status: 'failed',
      content_error: message,
      content: null,
      content_summary: null,
      read_at: null,
    })
    .eq('id', resourceId)
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to mark resource content failed', {
      resourceId, cause: error.message,
    })
  }
}

// Terminal but not an error: the format cannot be read, so there is nothing to
// retry and no message to show beyond the status itself.
export async function markResourceContentUnsupported(
  supabase: SupabaseClient<Database>,
  resourceId: string,
): Promise<void> {
  const { error } = await supabase
    .from('client_resources')
    .update({
      content_status: 'unsupported',
      content_error: null,
      content: null,
      content_summary: null,
      read_at: null,
    })
    .eq('id', resourceId)
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to mark resource content unsupported', {
      resourceId, cause: error.message,
    })
  }
}

export async function resetResourceContentToPending(
  supabase: SupabaseClient<Database>,
  resourceId: string,
): Promise<void> {
  const { error } = await supabase
    .from('client_resources')
    .update({
      content_status: 'pending',
      content: null,
      content_summary: null,
      content_error: null,
      read_at: null,
    })
    .eq('id', resourceId)
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to reset resource content', { resourceId, cause: error.message })
  }
}

export interface UpsertResourceKnowledgeSourceInput {
  clientId: string
  resourceId: string
  createdBy: string
  title: string
  content: string
}

/**
 * The companion knowledge source that makes a resource's content retrievable.
 *
 * Select-then-insert-or-update rather than an upsert: the unique index on
 * `resource_id` is partial (`where resource_id is not null`), and PostgREST's
 * onConflict cannot restate a partial index's WHERE clause for arbiter
 * inference. Same reasoning as insertPendingWebsiteSources in client-knowledge.ts.
 *
 * `storage_path` is deliberately left unset: the bytes live in the
 * client-resources bucket, and everything that signs a URL from a source row
 * assumes the knowledge bucket. `resource_id` is the pointer instead.
 */
export async function upsertResourceKnowledgeSource(
  supabase: SupabaseClient<Database>,
  input: UpsertResourceKnowledgeSourceInput,
): Promise<string> {
  const { data: existing, error: selectError } = await supabase
    .from('client_knowledge_sources')
    .select('id')
    .eq('resource_id', input.resourceId)
    .maybeSingle()
  if (selectError) {
    throw new AppError('DB_ERROR', 'Failed to look up the resource knowledge source', {
      resourceId: input.resourceId, cause: selectError.message,
    })
  }

  const fields = {
    client_id: input.clientId,
    resource_id: input.resourceId,
    source_type: 'resource' as const,
    title: input.title,
    content: input.content,
    char_count: input.content.length,
    // Created only once the content exists, so this row never sits pending.
    status: 'ready' as const,
    created_by: input.createdBy,
    scraped_at: new Date().toISOString(),
  }

  if (existing) {
    const { error } = await supabase
      .from('client_knowledge_sources')
      .update(fields)
      .eq('id', existing.id)
    if (error) {
      throw new AppError('DB_ERROR', 'Failed to update the resource knowledge source', {
        resourceId: input.resourceId, cause: error.message,
      })
    }
    return existing.id
  }

  const { data, error } = await supabase
    .from('client_knowledge_sources')
    .insert(fields)
    .select('id')
    .single()
  if (error || !data) {
    throw new AppError('DB_ERROR', 'Failed to insert the resource knowledge source', {
      resourceId: input.resourceId, cause: error?.message,
    })
  }
  return data.id
}

// Chunks cascade via client_knowledge_chunks.source_id. Called when a resource
// is deactivated: without this the agent keeps answering from a file it can no
// longer attach.
export async function deleteResourceKnowledgeSource(
  supabase: SupabaseClient<Database>,
  resourceId: string,
): Promise<void> {
  const { error } = await supabase
    .from('client_knowledge_sources')
    .delete()
    .eq('resource_id', resourceId)
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to delete the resource knowledge source', {
      resourceId, cause: error.message,
    })
  }
}

// Oldest first: the backfill should clear the queue that has been waiting
// longest, and a partial run then resumes where the previous one stopped.
export async function listResourcesAwaitingContent(
  supabase: SupabaseClient<Database>,
  limit: number,
): Promise<{ id: string; client_id: string }[]> {
  const { data, error } = await supabase
    .from('client_resources')
    .select('id, client_id')
    .eq('is_active', true)
    .eq('content_status', 'pending')
    .order('created_at', { ascending: true })
    .limit(limit)
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to list resources awaiting content', { cause: error.message })
  }
  return data ?? []
}
