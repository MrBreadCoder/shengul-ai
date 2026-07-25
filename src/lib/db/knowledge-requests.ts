import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { AppError } from '@/lib/errors/app-error'

export type KnowledgeRequestRow = Database['public']['Tables']['knowledge_requests']['Row']
export type KnowledgeRequestInsert = Database['public']['Tables']['knowledge_requests']['Insert']

// One knowledge request per inbound email (unique index on email_id from
// migration 0007). ignoreDuplicates makes a retried reply run idempotent — an
// existing request returns null and no duplicate escalation is created.
export async function createKnowledgeRequest(
  supabase: SupabaseClient<Database>,
  row: KnowledgeRequestInsert,
): Promise<KnowledgeRequestRow | null> {
  const { data, error } = await supabase
    .from('knowledge_requests')
    .upsert(row, { onConflict: 'email_id', ignoreDuplicates: true })
    .select('*')
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to create knowledge request', {
      emailId: row.email_id, caseId: row.case_id, cause: error.message,
    })
  }
  // length check guarantees index 0 exists.
  return data && data.length > 0 ? data[0]! : null
}

export async function getKnowledgeRequestById(
  supabase: SupabaseClient<Database>,
  id: string,
): Promise<KnowledgeRequestRow | null> {
  const { data, error } = await supabase
    .from('knowledge_requests')
    .select('*')
    .eq('id', id)
    .maybeSingle()
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to load knowledge request', { id, cause: error.message })
  }
  return data
}

// RLS-scoped: pass a session-bound server client so a client role only sees its
// own open requests. Used by /inbox.
export async function listOpenKnowledgeRequestsForClient(
  supabase: SupabaseClient<Database>,
): Promise<KnowledgeRequestRow[]> {
  const { data, error } = await supabase
    .from('knowledge_requests')
    .select('*')
    .eq('status', 'open')
    .order('created_at', { ascending: false })
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to list open knowledge requests', { cause: error.message })
  }
  return data ?? []
}

// Atomically claims an open request and records the human answer. The
// .eq('status','open') guard means only the first submitter wins; a retry or a
// second operator gets null and must not re-run the answer pipeline. Run with an
// admin client so RLS can't silently no-op the write.
export async function claimKnowledgeRequestAnswer(
  supabase: SupabaseClient<Database>,
  input: { id: string; answer: string; answeredBy: string },
): Promise<KnowledgeRequestRow | null> {
  const { data, error } = await supabase
    .from('knowledge_requests')
    .update({
      status: 'answered',
      human_answer: input.answer,
      answered_by: input.answeredBy,
      answered_at: new Date().toISOString(),
    })
    .eq('id', input.id)
    .eq('status', 'open')
    .select('*')
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to claim knowledge request answer', { id: input.id, cause: error.message })
  }
  // length check guarantees index 0 exists.
  return data && data.length > 0 ? data[0]! : null
}

// Every knowledge request raised on a case, open or resolved, newest first.
export async function listKnowledgeRequestsForCase(
  supabase: SupabaseClient<Database>,
  caseId: string,
): Promise<KnowledgeRequestRow[]> {
  const { data, error } = await supabase
    .from('knowledge_requests')
    .select('*')
    .eq('case_id', caseId)
    .order('created_at', { ascending: false })
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to list knowledge requests for case', {
      caseId,
      cause: error.message,
    })
  }
  return data ?? []
}
