import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireUser } from '@/lib/auth/require-user'
import { createAdminClient } from '@/lib/supabase/admin'
import { getMailboxById, updateMailboxOauth } from '@/lib/db/mailboxes'
import { getMailboxProvider } from '@/lib/mailbox/registry'
import { logEvent } from '@/lib/events/log-event'
import { isAppError } from '@/lib/errors/app-error'
import type { MailboxTokens } from '@/lib/mailbox/provider'

export const runtime = 'nodejs'

const oauthSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresAt: z.string(),
})

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { appUser } = await requireUser()
  if (appUser.role !== 'operator') return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  const { id } = await context.params
  try {
    const admin = createAdminClient()
    const mailbox = await getMailboxById(admin, id)
    if (!mailbox) return NextResponse.json({ error: 'not_found' }, { status: 404 })

    const tokens: MailboxTokens = oauthSchema.parse(mailbox.oauth)
    const provider = getMailboxProvider(mailbox.provider)
    const { result, tokens: nextTokens } = await provider.sendEmail(tokens, {
      to: mailbox.email_address, // test email to self
      subject: 'AI B2B test email',
      body: 'This is a P0 connectivity test from AI B2B. If you received this, sending works.',
    })
    if (nextTokens.accessToken !== tokens.accessToken) {
      await updateMailboxOauth(admin, id, { ...nextTokens })
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
