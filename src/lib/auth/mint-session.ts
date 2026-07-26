import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { AppError } from '@/lib/errors/app-error'

/**
 * Signs a user in server-side, without a password and without spending
 * anything the invited person is holding.
 *
 * This is the piece that makes an invite link reusable inside its window.
 * Supabase's own email tokens are single-use, so putting one in the URL means
 * the first fetch of that URL — very often a mail or chat platform prefetching
 * the link, not the recipient — permanently consumes it. Instead the URL
 * carries our own token, and every redemption mints a *fresh* Supabase token
 * here and immediately spends it. The token that gets consumed is one that
 * existed for microseconds and never left the server.
 *
 * `admin` must be the service-role client; `supabase` must be the request's
 * server client, because `verifyOtp` is what writes the session cookies onto
 * the outgoing response.
 */
export async function mintSessionForEmail(
  admin: SupabaseClient<Database>,
  supabase: SupabaseClient<Database>,
  email: string,
): Promise<void> {
  const { data, error } = await admin.auth.admin.generateLink({ type: 'magiclink', email })
  if (error || !data.properties?.hashed_token) {
    throw new AppError('EXTERNAL_ERROR', 'Failed to mint a sign-in token', {
      cause: error?.message ?? 'no hashed_token returned',
    })
  }

  const { error: verifyError } = await supabase.auth.verifyOtp({
    type: 'magiclink',
    token_hash: data.properties.hashed_token,
  })
  if (verifyError) {
    throw new AppError('EXTERNAL_ERROR', 'Failed to establish a session', { cause: verifyError.message })
  }
}
