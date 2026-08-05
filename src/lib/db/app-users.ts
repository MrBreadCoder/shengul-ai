import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { AppError } from '@/lib/errors/app-error'
import type { AppLocale } from '@/types/i18n'

export type AppUser = Database['public']['Tables']['app_users']['Row']

export async function getAppUser(
  supabase: SupabaseClient<Database>,
  userId: string,
): Promise<AppUser | null> {
  const { data, error } = await supabase
    .from('app_users')
    .select('*')
    .eq('id', userId)
    .maybeSingle()
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to load app_user', { userId, cause: error.message })
  }
  return data
}

export async function updateUserLocale(
  supabase: SupabaseClient<Database>,
  userId: string,
  locale: AppLocale,
): Promise<AppUser> {
  const { data, error } = await supabase
    .from('app_users')
    .update({ locale })
    .eq('id', userId)
    .select('*')
    .single()
  if (error || !data) {
    throw new AppError('DB_ERROR', 'Failed to update user locale', { userId, cause: error?.message })
  }
  return data
}
