import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth/require-user'
import { createAdminClient } from '@/lib/supabase/admin'
import { getMailboxById, updateMailboxOauth } from '@/lib/db/mailboxes'
import { getMailboxProvider } from '@/lib/mailbox/registry'
import { parseMailboxTokens, encryptMailboxTokens } from '@/lib/mailbox/tokens'
import { logEvent } from '@/lib/events/log-event'
import { isAppError } from '@/lib/errors/app-error'
import type { Json } from '@/types/database'

export const runtime = 'nodejs'

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { appUser } = await requireUser()
  if (appUser.role !== 'operator') return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  const { id } = await context.params
  try {
    const admin = createAdminClient()
    const mailbox = await getMailboxById(admin, id)
    if (!mailbox) return NextResponse.json({ error: 'not_found' }, { status: 404 })

    // parseMailboxTokens (not a route-local schema) so this endpoint decrypts
    // tokens the same way every other mailbox code path does, and accepts both
    // encrypted-at-rest and legacy plaintext rows identically.
    const tokens = parseMailboxTokens(mailbox.oauth, id)
    const provider = getMailboxProvider(mailbox.provider)
    const { result, tokens: nextTokens } = await provider.sendEmail(tokens, {
      to: mailbox.email_address, // test email to self
      subject: 'AI B2B test email',
      body: 'This is a P0 connectivity test from AI B2B. If you received this, sending works.',
    })
    if (nextTokens !== tokens) {
      // Reference inequality: every provider returns the same credentials
      // object back unchanged when nothing needed persisting (SMTP always;
      // OAuth only refreshes when the access token was near expiry), so this
      // is the only comparison that works across both credential kinds.
      //
      // Cast is safe: parseMailboxTokens above already proved mailbox.oauth is a
      // well-formed tokens object, not a primitive/array/null. The CAS guard
      // avoids clobbering a token a concurrent send/read already refreshed.
      await updateMailboxOauth(admin, id, encryptMailboxTokens(nextTokens), mailbox.oauth as Record<string, Json>)
    }
    await logEvent({
      clientId: mailbox.client_id, actor: `human:${appUser.id}`, type: 'mailbox.test_email_sent',
      payload: { mailboxId: id, provider: mailbox.provider, providerMessageId: result.providerMessageId },
    })
    return NextResponse.json({ ok: true, providerMessageId: result.providerMessageId })
  } catch (error) {
    const code = isAppError(error) ? error.code : 'unknown'
    return NextResponse.json({ error: code }, { status: 500 })
  }
}
