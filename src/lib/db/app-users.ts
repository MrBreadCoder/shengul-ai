import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { AppError } from '@/lib/errors/app-error'

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
