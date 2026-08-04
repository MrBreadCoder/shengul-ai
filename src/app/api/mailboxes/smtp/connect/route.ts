import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireUser } from '@/lib/auth/require-user'
import { createAdminClient } from '@/lib/supabase/admin'
import { insertMailbox } from '@/lib/db/mailboxes'
import { getClientById, resolveMailboxClientId } from '@/lib/db/clients'
import { logEvent, logWarn, logError } from '@/lib/events/log-event'
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
  // Both roles may connect a mailbox; a client-role account only lacks
  // `client_id` in a state the UI should never let reach here.
  if (appUser.role === 'client' && appUser.client_id === null) {
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

  // Resolved before verification (not just before insert) so a failed
  // connection attempt can still be logged against the right client — an
  // operator's demo-client lookup and a client-role user's own client_id are
  // both cheap and side-effect-free to resolve early.
  const admin = createAdminClient()
  let clientId: string
  try {
    clientId = await resolveMailboxClientId(admin, appUser)
  } catch (error) {
    // No clientId to scope this to yet — that's exactly what failed to
    // resolve — so it logs against no client rather than being dropped.
    const cause = isAppError(error) && typeof error.context.cause === 'string' ? error.context.cause : undefined
    await logError({
      clientId: null,
      actor: `human:${appUser.id}`,
      type: 'mailbox.connect_error',
      source: 'mailbox',
      error,
      payload: { provider: 'smtp', stage: 'resolve_client', dbError: cause ?? null },
    })
    const code = isAppError(error) ? error.code : 'unknown'
    const status = isAppError(error) && error.code === 'FORBIDDEN' ? 403 : 500
    return NextResponse.json({ error: code }, { status })
  }

  // Both legs must authenticate before anything is written: a mailbox whose
  // IMAP credentials are wrong would send fine and silently never detect a
  // reply or a bounce.
  try {
    await verifySmtpConnection(credentials)
    await verifyImapConnection(credentials)
  } catch (error) {
    // Best-effort and structured (no password): this is the only place that
    // captures *why* Yandex/Gmail/etc. rejected the attempt. `cause` is the
    // mail server's own reply text (e.g. an SMTP 535 banner) — never sent to
    // the browser (see the comment on `verificationFailure`), but safe in an
    // operator-only log since it never contains the credentials themselves.
    const stage = isAppError(error) && typeof error.context.stage === 'string' ? error.context.stage : undefined
    const cause = isAppError(error) && typeof error.context.cause === 'string' ? error.context.cause : undefined
    await logWarn({
      clientId,
      actor: `human:${appUser.id}`,
      type: 'mailbox.connect_failed',
      source: 'mailbox',
      error,
      payload: {
        provider: 'smtp',
        emailAddress: credentials.emailAddress,
        smtpHost: credentials.smtpHost,
        imapHost: credentials.imapHost,
        stage: stage ?? null,
        serverResponse: cause ?? null,
      },
    })
    return verificationFailure(error)
  }

  // Tracked outside the try so the catch below can tell a genuine insert
  // failure (nothing written) apart from the row having been created and only
  // the follow-up audit-log write failing — those need different fixes.
  let mailbox: { id: string } | undefined
  try {
    // A newly connected mailbox starts at the client's configured ramp, the
    // same as an OAuth one.
    const client = await getClientById(admin, clientId)
    mailbox = await insertMailbox(admin, {
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
    // `cause` is the raw Postgres error text (e.g. a unique-constraint or
    // foreign-key violation) that `insertMailbox`/`logEvent` wrap into a
    // generic AppError message — describeError alone would only ever surface
    // "Failed to insert mailbox", never the reason it actually failed.
    const cause = isAppError(error) && typeof error.context.cause === 'string' ? error.context.cause : undefined
    await logError({
      clientId,
      actor: `human:${appUser.id}`,
      type: 'mailbox.connect_error',
      source: 'mailbox',
      error,
      payload: {
        provider: 'smtp',
        emailAddress: credentials.emailAddress,
        // Present only when the row was actually created — tells the operator
        // whether this is a stuck duplicate or a genuine insert failure.
        mailboxId: mailbox?.id ?? null,
        stage: mailbox ? 'post_insert' : 'insert',
        dbError: cause ?? null,
      },
    })
    const code = isAppError(error) ? error.code : 'unknown'
    return NextResponse.json({ error: code }, { status: 500 })
  }
}
