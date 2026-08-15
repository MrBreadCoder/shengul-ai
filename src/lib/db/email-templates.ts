import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { AppError } from '@/lib/errors/app-error'

export type EmailTemplateRow = Database['public']['Tables']['email_templates']['Row']

const POSTGRES_UNIQUE_VIOLATION = '23505'

export async function listEmailTemplates(supabase: SupabaseClient<Database>): Promise<EmailTemplateRow[]> {
  const { data, error } = await supabase.from('email_templates').select('*').order('name')
  if (error) throw new AppError('DB_ERROR', 'Failed to list email templates', { cause: error.message })
  return data ?? []
}

export async function getEmailTemplateById(
  supabase: SupabaseClient<Database>,
  id: string,
): Promise<EmailTemplateRow | null> {
  const { data, error } = await supabase.from('email_templates').select('*').eq('id', id).maybeSingle()
  if (error) throw new AppError('DB_ERROR', 'Failed to load email template', { id, cause: error.message })
  return data
}

// Always exists post-migration — the DB's partial unique index on is_default
// guarantees at most one row is ever marked default, and every migration
// that adds a template leaves exactly one. Throws loudly rather than silently
// falling back to hardcoded prompt text if that invariant is ever broken,
// per QUALITY.md's "fail loudly, fail explicitly" rule.
export async function getDefaultEmailTemplate(supabase: SupabaseClient<Database>): Promise<EmailTemplateRow> {
  const { data, error } = await supabase.from('email_templates').select('*').eq('is_default', true).maybeSingle()
  if (error) throw new AppError('DB_ERROR', 'Failed to load default email template', { cause: error.message })
  if (!data) throw new AppError('INVARIANT_VIOLATION', 'No email template is marked default', {})
  return data
}

export interface CreateEmailTemplateInput {
  name: string
  templateText: string
}

export async function createEmailTemplate(
  supabase: SupabaseClient<Database>,
  input: CreateEmailTemplateInput,
): Promise<EmailTemplateRow> {
  const { data, error } = await supabase
    .from('email_templates')
    .insert({ name: input.name, template_text: input.templateText })
    .select('*')
    .single()
  if (error) {
    if (error.code === POSTGRES_UNIQUE_VIOLATION) {
      throw new AppError('EMAIL_TEMPLATE_NAME_TAKEN', `An email template named "${input.name}" already exists`, {
        name: input.name,
      })
    }
    throw new AppError('DB_ERROR', 'Failed to create email template', { cause: error.message })
  }
  if (!data) throw new AppError('DB_ERROR', 'Failed to create email template', {})
  return data
}

export interface UpdateEmailTemplateInput {
  name?: string
  templateText?: string
}

export async function updateEmailTemplate(
  supabase: SupabaseClient<Database>,
  id: string,
  input: UpdateEmailTemplateInput,
): Promise<EmailTemplateRow> {
  const patch: Database['public']['Tables']['email_templates']['Update'] = {}
  if (input.name !== undefined) patch.name = input.name
  if (input.templateText !== undefined) patch.template_text = input.templateText

  const { data, error } = await supabase.from('email_templates').update(patch).eq('id', id).select('*').maybeSingle()
  if (error) {
    if (error.code === POSTGRES_UNIQUE_VIOLATION) {
      throw new AppError('EMAIL_TEMPLATE_NAME_TAKEN', `An email template named "${input.name}" already exists`, {
        name: input.name,
      })
    }
    throw new AppError('DB_ERROR', 'Failed to update email template', { id, cause: error.message })
  }
  if (!data) throw new AppError('EMAIL_TEMPLATE_NOT_FOUND', 'Email template not found', { id })
  return data
}

// Wraps the unset-old/set-new pair in the set_default_email_template Postgres
// function (migration 0035, renamed 0046) so a crash between the two updates
// can never leave zero templates marked default — the DB's partial unique
// index on is_default forbids two rows being true at once, so this cannot
// safely be two independent supabase-js calls without a transaction.
export async function setDefaultEmailTemplate(
  supabase: SupabaseClient<Database>,
  id: string,
): Promise<EmailTemplateRow> {
  const { data, error } = await supabase.rpc('set_default_email_template', { p_id: id })
  if (error) {
    if (error.code === 'P0002') {
      throw new AppError('EMAIL_TEMPLATE_NOT_FOUND', 'Email template not found', { id })
    }
    throw new AppError('DB_ERROR', 'Failed to set default email template', { id, cause: error.message })
  }
  // length check guarantees index 0 exists — mirrors claimMailboxSend's
  // identical setof-RPC-to-single-row pattern (lib/db/mailboxes.ts).
  if (!data || data.length === 0) {
    throw new AppError('DB_ERROR', 'Failed to set default email template', { id })
  }
  return data[0]!
}

// Deleting an in-use, non-default template falls every client AND every
// campaign using it back to whichever template is default. Reassign-then-
// delete is safe even if the process crashes between steps: the row simply
// remains undeleted with zero clients/campaigns pointing to it, never a
// dangling foreign key.
export async function deleteEmailTemplate(supabase: SupabaseClient<Database>, id: string): Promise<void> {
  const template = await getEmailTemplateById(supabase, id)
  if (!template) throw new AppError('EMAIL_TEMPLATE_NOT_FOUND', 'Email template not found', { id })
  if (template.is_default) {
    throw new AppError('CANNOT_DELETE_DEFAULT_TEMPLATE', 'Cannot delete the default email template', { id })
  }

  const { error: reassignClientsError } = await supabase
    .from('clients')
    .update({ email_template_id: null })
    .eq('email_template_id', id)
  if (reassignClientsError) {
    throw new AppError('DB_ERROR', 'Failed to reassign clients off the deleted email template', {
      id,
      cause: reassignClientsError.message,
    })
  }

  const { error: reassignCampaignsError } = await supabase
    .from('campaigns')
    .update({ email_template_id: null })
    .eq('email_template_id', id)
  if (reassignCampaignsError) {
    throw new AppError('DB_ERROR', 'Failed to reassign campaigns off the deleted email template', {
      id,
      cause: reassignCampaignsError.message,
    })
  }

  const { error: deleteError } = await supabase.from('email_templates').delete().eq('id', id)
  if (deleteError) {
    throw new AppError('DB_ERROR', 'Failed to delete email template', { id, cause: deleteError.message })
  }
}
