import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'

const DEFAULT_NEXT_PATH = '/set-password'

// `new URL(next, base)` happily resolves an absolute or protocol-relative
// `next` value to a different origin — an unvalidated `next` param is an open
// redirect. Only accept a same-origin relative path.
function sanitizeNextPath(next: string | null): string {
  if (!next) return DEFAULT_NEXT_PATH
  if (!next.startsWith('/') || next.startsWith('//') || next.includes('://')) {
    return DEFAULT_NEXT_PATH
  }
  return next
}

export async function GET(request: Request) {
  const url = new URL(request.url)
  const code = url.searchParams.get('code')
  const next = sanitizeNextPath(url.searchParams.get('next'))

  if (!code) {
    return NextResponse.redirect(new URL('/login', url))
  }

  const supabase = await createServerClient()
  const { error } = await supabase.auth.exchangeCodeForSession(code)
  if (error) {
    return NextResponse.redirect(new URL('/login?error=invite_expired', url))
  }

  return NextResponse.redirect(new URL(next, url))
}
