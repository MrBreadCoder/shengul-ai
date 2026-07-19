import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database, Json } from '@/types/database'
import { AppError } from '@/lib/errors/app-error'

export type MailboxRow = Database['public']['Tables']['mailboxes']['Row']
export type MailboxInsert = Database['public']['Tables']['mailboxes']['Insert']

export async function insertMailbox(
  supabase: SupabaseClient<Database>,
  row: MailboxInsert,
): Promise<MailboxRow> {
  const { data, error } = await supabase.from('mailboxes').insert(row).select('*').single()
  if (error || !data) {
    throw new AppError('DB_ERROR', 'Failed to insert mailbox', { cause: error?.message })
  }
  return data
}

export async function getMailboxById(
  supabase: SupabaseClient<Database>,
  id: string,
): Promise<MailboxRow | null> {
  const { data, error } = await supabase.from('mailboxes').select('*').eq('id', id).maybeSingle()
  if (error) throw new AppError('DB_ERROR', 'Failed to load mailbox', { id, cause: error.message })
  return data
}

export async function updateMailboxOauth(
  supabase: SupabaseClient<Database>,
  id: string,
  oauth: Record<string, Json>,
): Promise<void> {
  const { error } = await supabase.from('mailboxes').update({ oauth }).eq('id', id)
  if (error) throw new AppError('DB_ERROR', 'Failed to update mailbox oauth', { id, cause: error.message })
}
