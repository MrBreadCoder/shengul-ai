import { createServerClient as createSsrClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import type { Database } from '@/types/database'
import { env } from '@/lib/env'
import { isPublicPath } from '@/lib/auth/public-paths'

export async function updateSession(request: NextRequest): Promise<NextResponse> {
  let response = NextResponse.next({ request })
  const supabase = createSsrClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (toSet) => {
          for (const { name, value } of toSet) request.cookies.set(name, value)
          response = NextResponse.next({ request })
          for (const { name, value, options } of toSet) response.cookies.set(name, value, options)
        },
      },
    },
  )
  const { data } = await supabase.auth.getUser()
  const isAuthed = data.user !== null
  const { pathname } = request.nextUrl
  if (!isAuthed && !isPublicPath(pathname)) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    return NextResponse.redirect(url)
  }
  return response
}
