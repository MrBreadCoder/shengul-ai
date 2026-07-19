import { redirect } from 'next/navigation'
import type { User } from '@supabase/supabase-js'
import { createServerClient } from '@/lib/supabase/server'
import { getAppUser, type AppUser } from '@/lib/db/app-users'

export interface AuthedUser {
  user: User
  appUser: AppUser
}

// For pages/route handlers. Redirects to /login if no session or no app_users row.
export async function requireUser(): Promise<AuthedUser> {
  const supabase = await createServerClient()
  const { data } = await supabase.auth.getUser()
  if (!data.user) redirect('/login')
  const appUser = await getAppUser(supabase, data.user.id)
  if (!appUser) redirect('/login')
  return { user: data.user, appUser }
}
