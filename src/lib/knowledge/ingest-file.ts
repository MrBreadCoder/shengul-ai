import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import {
  assertValidKnowledgeFile, uploadClientKnowledgeFile, extractKnowledgeText,
} from '@/lib/storage/client-knowledge-files'
import { insertFileSourceReady, embedAndStoreChunks, type KnowledgeSourceRow } from '@/lib/db/client-knowledge'

export interface IngestKnowledgeFileInput {
  clientId: string
  createdBy: string
  file: File
  actor: string
}

/**
 * file → storage → text → source row → embedded chunks.
 *
 * Everything happens inline: unlike a website page's Brightdata scrape there is
 * no network dependency to defer to QStash, so the row is created already
 * 'ready' and there is no pending window to show.
 */
export async function ingestKnowledgeFile(
  supabase: SupabaseClient<Database>,
  input: IngestKnowledgeFileInput,
): Promise<KnowledgeSourceRow> {
  assertValidKnowledgeFile(input.file)
  const storagePath = await uploadClientKnowledgeFile(supabase, input.clientId, input.file)
  const content = await extractKnowledgeText(input.file)

  const source = await insertFileSourceReady(supabase, {
    clientId: input.clientId,
    createdBy: input.createdBy,
    title: input.file.name,
    storagePath,
    content,
    charCount: content.length,
    sourceType: input.file.type === 'application/pdf' ? 'pdf' : 'file',
  })
  await embedAndStoreChunks(supabase, {
    clientId: input.clientId, sourceId: source.id, content, actor: input.actor,
  })
  return source
}
