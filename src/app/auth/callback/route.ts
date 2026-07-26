import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getInviteLinkByTokenHash } from '@/lib/db/invite-links'
import { getAuthUserEmail } from '@/lib/supabase/auth-admin'
import { hashInviteToken, inviteTokenHashEquals } from '@/lib/auth/invite-token'
import { mintSessionForEmail } from '@/lib/auth/mint-session'

export const runtime = 'nodejs'

const DEFAULT_NEXT_PATH = '/set-password'
const EXPIRED_PATH = '/auth/invite-expired'

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
 * `invite` is our own reusable link (see `lib/auth/invite-token.ts`).
 * `otp` covers Supabase-native email links, which remain single-use.
 * `code` is the PKCE path used by OAuth sign-ins.
 */
type Credential =
  | { kind: 'invite'; token: string }
  | { kind: 'otp'; tokenHash: string; type: EmailOtpType }
  | { kind: 'code'; code: string }

function isEmailOtpType(value: string | null): value is EmailOtpType {
  return value !== null && (EMAIL_OTP_TYPES as readonly string[]).includes(value)
}

function readCredential(url: URL): Credential | null {
  const token = url.searchParams.get('token')
  if (token) return { kind: 'invite', token }

  const tokenHash = url.searchParams.get('token_hash')
  const type = url.searchParams.get('type')
  if (tokenHash && isEmailOtpType(type)) return { kind: 'otp', tokenHash, type }

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

function expiredRedirect(url: URL, reason: 'expired' | 'invalid'): NextResponse {
  const target = new URL(EXPIRED_PATH, url)
  target.searchParams.set('reason', reason)
  return NextResponse.redirect(target)
}

/**
 * Redeems one of our own invite tokens.
 *
 * Nothing here consumes the token: it stays valid until `expires_at`, so a
 * mail scanner that fetches the link ahead of the recipient no longer locks
 * them out. An unknown token and a lapsed one are reported separately — the
 * first means the link was never real, the second that it simply needs
 * reissuing, and telling a stranded user the wrong one wastes their time.
 */
async function redeemInvite(url: URL, token: string, next: string): Promise<NextResponse> {
  const admin = createAdminClient()
  const tokenHash = hashInviteToken(token)
  const link = await getInviteLinkByTokenHash(admin, tokenHash)

  if (!link || !inviteTokenHashEquals(link.token_hash, tokenHash)) {
    return expiredRedirect(url, 'invalid')
  }
  if (new Date(link.expires_at).getTime() <= Date.now()) {
    return expiredRedirect(url, 'expired')
  }

  const email = await getAuthUserEmail(admin, link.user_id)
  if (!email) return expiredRedirect(url, 'invalid')

  const supabase = await createServerClient()
  await mintSessionForEmail(admin, supabase, email)

  return NextResponse.redirect(new URL(next, url))
}

export async function GET(request: Request) {
  const url = new URL(request.url)
  const next = sanitizeNextPath(url.searchParams.get('next'))
  const credential = readCredential(url)

  if (!credential) {
    return NextResponse.redirect(new URL('/login', url))
  }

  try {
    if (credential.kind === 'invite') {
      return await redeemInvite(url, credential.token, next)
    }

    const supabase = await createServerClient()
    const { error } =
      credential.kind === 'otp'
        ? await supabase.auth.verifyOtp({ type: credential.type, token_hash: credential.tokenHash })
        : await supabase.auth.exchangeCodeForSession(credential.code)

    if (error) return expiredRedirect(url, 'expired')

    return NextResponse.redirect(new URL(next, url))
  } catch {
    // Every failure below the credential check is infrastructure, not the
    // visitor's doing. They cannot act on a stack trace, and the one thing
    // that always helps is a fresh link, so send them where that is offered.
    return expiredRedirect(url, 'expired')
  }
}
