import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { AppError } from '@/lib/errors/app-error'

export type EmailStyleRow = Database['public']['Tables']['email_styles']['Row']

const POSTGRES_UNIQUE_VIOLATION = '23505'

export async function listEmailStyles(supabase: SupabaseClient<Database>): Promise<EmailStyleRow[]> {
  const { data, error } = await supabase.from('email_styles').select('*').order('name')
  if (error) throw new AppError('DB_ERROR', 'Failed to list email styles', { cause: error.message })
  return data ?? []
}

export async function getEmailStyleById(
  supabase: SupabaseClient<Database>,
  id: string,
): Promise<EmailStyleRow | null> {
  const { data, error } = await supabase.from('email_styles').select('*').eq('id', id).maybeSingle()
  if (error) throw new AppError('DB_ERROR', 'Failed to load email style', { id, cause: error.message })
  return data
}

// Always exists post-migration — the DB's partial unique index on is_default
// guarantees at most one row is ever marked default, and every migration
// that adds a style leaves exactly one. Throws loudly rather than silently
// falling back to hardcoded prompt text if that invariant is ever broken,
// per QUALITY.md's "fail loudly, fail explicitly" rule.
export async function getDefaultEmailStyle(supabase: SupabaseClient<Database>): Promise<EmailStyleRow> {
  const { data, error } = await supabase.from('email_styles').select('*').eq('is_default', true).maybeSingle()
  if (error) throw new AppError('DB_ERROR', 'Failed to load default email style', { cause: error.message })
  if (!data) throw new AppError('INVARIANT_VIOLATION', 'No email style is marked default', {})
  return data
}

export interface CreateEmailStyleInput {
  name: string
  voiceInstructions: string
}

export async function createEmailStyle(
  supabase: SupabaseClient<Database>,
  input: CreateEmailStyleInput,
): Promise<EmailStyleRow> {
  const { data, error } = await supabase
    .from('email_styles')
    .insert({ name: input.name, voice_instructions: input.voiceInstructions })
    .select('*')
    .single()
  if (error) {
    if (error.code === POSTGRES_UNIQUE_VIOLATION) {
      throw new AppError('EMAIL_STYLE_NAME_TAKEN', `An email style named "${input.name}" already exists`, {
        name: input.name,
      })
    }
    throw new AppError('DB_ERROR', 'Failed to create email style', { cause: error.message })
  }
  if (!data) throw new AppError('DB_ERROR', 'Failed to create email style', {})
  return data
}

export interface UpdateEmailStyleInput {
  name?: string
  voiceInstructions?: string
}

export async function updateEmailStyle(
  supabase: SupabaseClient<Database>,
  id: string,
  input: UpdateEmailStyleInput,
): Promise<EmailStyleRow> {
  const patch: Database['public']['Tables']['email_styles']['Update'] = {}
  if (input.name !== undefined) patch.name = input.name
  if (input.voiceInstructions !== undefined) patch.voice_instructions = input.voiceInstructions

  const { data, error } = await supabase.from('email_styles').update(patch).eq('id', id).select('*').maybeSingle()
  if (error) {
    if (error.code === POSTGRES_UNIQUE_VIOLATION) {
      throw new AppError('EMAIL_STYLE_NAME_TAKEN', `An email style named "${input.name}" already exists`, {
        name: input.name,
      })
    }
    throw new AppError('DB_ERROR', 'Failed to update email style', { id, cause: error.message })
  }
  if (!data) throw new AppError('EMAIL_STYLE_NOT_FOUND', 'Email style not found', { id })
  return data
}

// Wraps the unset-old/set-new pair in the set_default_email_style Postgres
// function (migration 0035) so a crash between the two updates can never
// leave zero styles marked default — the DB's partial unique index on
// is_default forbids two rows being true at once, so this cannot safely be
// two independent supabase-js calls without a transaction.
export async function setDefaultEmailStyle(
  supabase: SupabaseClient<Database>,
  id: string,
): Promise<EmailStyleRow> {
  const { data, error } = await supabase.rpc('set_default_email_style', { p_id: id })
  if (error) {
    if (error.code === 'P0002') {
      throw new AppError('EMAIL_STYLE_NOT_FOUND', 'Email style not found', { id })
    }
    throw new AppError('DB_ERROR', 'Failed to set default email style', { id, cause: error.message })
  }
  // length check guarantees index 0 exists — mirrors claimMailboxSend's
  // identical setof-RPC-to-single-row pattern (lib/db/mailboxes.ts).
  if (!data || data.length === 0) {
    throw new AppError('DB_ERROR', 'Failed to set default email style', { id })
  }
  return data[0]!
}

// Deleting an in-use, non-default style falls clients using it back to
// whichever style is default. Reassign-then-delete is safe even if the
// process crashes between the two steps: the row simply remains undeleted
// with zero clients pointing to it, never a dangling foreign key.
export async function deleteEmailStyle(supabase: SupabaseClient<Database>, id: string): Promise<void> {
  const style = await getEmailStyleById(supabase, id)
  if (!style) throw new AppError('EMAIL_STYLE_NOT_FOUND', 'Email style not found', { id })
  if (style.is_default) {
    throw new AppError('CANNOT_DELETE_DEFAULT_STYLE', 'Cannot delete the default email style', { id })
  }

  const { error: reassignError } = await supabase
    .from('clients')
    .update({ email_style_id: null })
    .eq('email_style_id', id)
  if (reassignError) {
    throw new AppError('DB_ERROR', 'Failed to reassign clients off the deleted email style', {
      id,
      cause: reassignError.message,
    })
  }

  const { error: deleteError } = await supabase.from('email_styles').delete().eq('id', id)
  if (deleteError) {
    throw new AppError('DB_ERROR', 'Failed to delete email style', { id, cause: deleteError.message })
  }
}
