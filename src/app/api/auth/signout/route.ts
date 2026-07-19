import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase/server'
import { env } from '@/lib/env'

export async function POST() {
  const supabase = await createServerClient()
  await supabase.auth.signOut()
  return NextResponse.redirect(new URL('/login', env.APP_URL), { status: 303 })
}
