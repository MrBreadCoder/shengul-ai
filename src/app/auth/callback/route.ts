import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'

const DEFAULT_NEXT_PATH = '/set-password'

/**
 * `EmailOtpType` in `@supabase/auth-js` is widened with `(string & {})`, so it
 * accepts any string and validates nothing. This is the closed set we are
 * willing to verify, so an attacker cannot probe GoTrue with arbitrary types.
 */
const EMAIL_OTP_TYPES = ['invite', 'signup', 'magiclink', 'recovery', 'email_change', 'email'] as const
type EmailOtpType = (typeof EMAIL_OTP_TYPES)[number]

/**
 * How the caller proved who they are.
 *
 * `otp` is what an admin-generated invite carries: `generateLink` produces a
 * `hashed_token`, never a PKCE code, because the server that asked for the link
 * holds no code verifier. `code` is the PKCE path, kept for OAuth sign-ins.
 */
type Credential =
  | { kind: 'otp'; tokenHash: string; type: EmailOtpType }
  | { kind: 'code'; code: string }

function isEmailOtpType(value: string | null): value is EmailOtpType {
  return value !== null && (EMAIL_OTP_TYPES as readonly string[]).includes(value)
}

function readCredential(url: URL): Credential | null {
  const tokenHash = url.searchParams.get('token_hash')
  const type = url.searchParams.get('type')
  if (tokenHash && isEmailOtpType(type)) {
    return { kind: 'otp', tokenHash, type }
  }

  const code = url.searchParams.get('code')
  if (code) return { kind: 'code', code }

  return null
}

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
  const next = sanitizeNextPath(url.searchParams.get('next'))
  const credential = readCredential(url)

  if (!credential) {
    return NextResponse.redirect(new URL('/login', url))
  }

  const supabase = await createServerClient()
  const { error } =
    credential.kind === 'otp'
      ? await supabase.auth.verifyOtp({ type: credential.type, token_hash: credential.tokenHash })
      : await supabase.auth.exchangeCodeForSession(credential.code)

  if (error) {
    return NextResponse.redirect(new URL('/login?error=invite_expired', url))
  }

  return NextResponse.redirect(new URL(next, url))
}
