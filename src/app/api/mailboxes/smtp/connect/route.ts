import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireUser } from '@/lib/auth/require-user'
import { createAdminClient } from '@/lib/supabase/admin'
import { insertMailbox } from '@/lib/db/mailboxes'
import { getClientById, getOrCreateOperatorClient } from '@/lib/db/clients'
import { logEvent } from '@/lib/events/log-event'
import { isAppError } from '@/lib/errors/app-error'
import { encryptMailboxTokens } from '@/lib/mailbox/tokens'
import { warmupInsertFields } from '@/lib/mailbox/warmup'
import { verifyImapConnection, verifySmtpConnection } from '@/lib/mailbox/smtp-connection'
import type { SmtpCredentials } from '@/lib/mailbox/provider'

// net/tls are not available on the edge runtime.
export const runtime = 'nodejs'

const portSchema = z.number().int().min(1).max(65535)
// 253 is the maximum length of a fully qualified domain name.
const hostSchema = z.string().min(1).max(253)

const bodySchema = z.object({
  emailAddress: z.string().email(),
  displayName: z.string().min(1).max(200).nullable().optional(),
  username: z.string().min(1),
  password: z.string().min(1),
  smtpHost: hostSchema,
  smtpPort: portSchema,
  smtpSecure: z.boolean(),
  imapHost: hostSchema,
  imapPort: portSchema,
  imapSecure: z.boolean(),
})

// Verification failures become a stable, machine-readable code the dialog
// branches on. The underlying library message stays server-side: it can carry
// the mail host's banner and internal policy text.
function verificationFailure(error: unknown): NextResponse {
  if (!isAppError(error)) {
    return NextResponse.json({ error: 'connection_failed' }, { status: 502 })
  }
  const stage = typeof error.context.stage === 'string' ? error.context.stage : undefined
  if (error.code === 'UNAUTHORIZED') {
    return NextResponse.json({ error: 'auth_failed', stage }, { status: 400 })
  }
  if (error.code === 'EXTERNAL_TIMEOUT') {
    return NextResponse.json({ error: 'timeout', stage }, { status: 504 })
  }
  return NextResponse.json({ error: 'connection_failed', stage }, { status: 502 })
}

export async function POST(request: Request) {
  const { appUser } = await requireUser()
  if (appUser.role !== 'operator') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  let json: unknown
  try {
    json = await request.json()
  } catch {
    return NextResponse.json({ error: 'validation_error' }, { status: 400 })
  }

  const parsed = bodySchema.safeParse(json)
  if (!parsed.success) {
    return NextResponse.json({ error: 'validation_error' }, { status: 400 })
  }

  const credentials: SmtpCredentials = {
    kind: 'smtp',
    emailAddress: parsed.data.emailAddress,
    username: parsed.data.username,
    password: parsed.data.password,
    smtpHost: parsed.data.smtpHost,
    smtpPort: parsed.data.smtpPort,
    smtpSecure: parsed.data.smtpSecure,
    imapHost: parsed.data.imapHost,
    imapPort: parsed.data.imapPort,
    imapSecure: parsed.data.imapSecure,
  }

  // Both legs must authenticate before anything is written: a mailbox whose
  // IMAP credentials are wrong would send fine and silently never detect a
  // reply or a bounce.
  try {
    await verifySmtpConnection(credentials)
    await verifyImapConnection(credentials)
  } catch (error) {
    return verificationFailure(error)
  }

  try {
    const admin = createAdminClient()
    const clientId = await getOrCreateOperatorClient(admin)
    // A newly connected mailbox starts at the client's configured ramp, the
    // same as an OAuth one.
    const client = await getClientById(admin, clientId)
    const mailbox = await insertMailbox(admin, {
      client_id: clientId,
      provider: 'smtp',
      email_address: credentials.emailAddress,
      display_name: parsed.data.displayName ?? null,
      oauth: encryptMailboxTokens(credentials),
      ...warmupInsertFields(client?.warmup_profile ?? 'standard', new Date()),
    })
    await logEvent({
      clientId,
      actor: `human:${appUser.id}`,
      type: 'mailbox.connected',
      // Host but never credentials — this payload is readable in the event log.
      payload: {
        mailboxId: mailbox.id,
        provider: 'smtp',
        emailAddress: credentials.emailAddress,
        smtpHost: credentials.smtpHost,
        imapHost: credentials.imapHost,
      },
    })
    return NextResponse.json({ ok: true, mailboxId: mailbox.id })
  } catch (error) {
    const code = isAppError(error) ? error.code : 'unknown'
    return NextResponse.json({ error: code }, { status: 500 })
  }
}
