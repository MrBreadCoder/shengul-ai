import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { AppError } from '@/lib/errors/app-error'

export type NoteRow = Database['public']['Tables']['notes']['Row']

export interface InsertNoteInput {
  clientId: string
  caseId: string
  /** Null = the note is about the company; set = about that person. */
  leadId: string | null
  body: string
  createdBy: string
}

/**
 * Every function here takes a session-bound `createServerClient`, never the
 * admin client. The notes policies (0020) are this table's authorization
 * boundary — bypassing RLS would remove it, unlike `emails`, where clients have
 * no write policy at all and an explicit app-side check does the work.
 */
export async function listNotesForCase(
  supabase: SupabaseClient<Database>,
  caseId: string,
): Promise<NoteRow[]> {
  const { data, error } = await supabase
    .from('notes')
    .select('*')
    .eq('case_id', caseId)
    .order('created_at', { ascending: false })
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to list notes for case', { caseId, cause: error.message })
  }
  return data ?? []
}

export async function insertNote(
  supabase: SupabaseClient<Database>,
  input: InsertNoteInput,
): Promise<NoteRow> {
  const { data, error } = await supabase
    .from('notes')
    .insert({
      client_id: input.clientId,
      case_id: input.caseId,
      lead_id: input.leadId,
      body: input.body,
      created_by: input.createdBy,
    })
    .select('*')
    .single()
  if (error || !data) {
    throw new AppError('DB_ERROR', 'Failed to insert note', {
      caseId: input.caseId,
      cause: error?.message ?? 'no row returned',
    })
  }
  return data
}

export async function getNoteById(
  supabase: SupabaseClient<Database>,
  id: string,
): Promise<NoteRow | null> {
  const { data, error } = await supabase.from('notes').select('*').eq('id', id).maybeSingle()
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to load note', { id, cause: error.message })
  }
  return data
}

// updated_at is written explicitly: this schema has no updated_at triggers
// (see cases.ts, which does the same).
// Returns null when the update matched no row — under RLS that is a note
// belonging to someone else, or one deleted in the meantime. The caller decides
// which error that is.
export async function updateNote(
  supabase: SupabaseClient<Database>,
  id: string,
  body: string,
): Promise<NoteRow | null> {
  const { data, error } = await supabase
    .from('notes')
    .update({ body, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('*')
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to update note', { id, cause: error.message })
  }
  // length check guarantees index 0 exists.
  return data && data.length > 0 ? data[0]! : null
}

// False means nothing was deleted — same two causes as updateNote returning null.
export async function deleteNote(
  supabase: SupabaseClient<Database>,
  id: string,
): Promise<boolean> {
  const { data, error } = await supabase.from('notes').delete().eq('id', id).select('id')
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to delete note', { id, cause: error.message })
  }
  return (data?.length ?? 0) > 0
}
