import { NextResponse } from 'next/server'
import { z } from 'zod'
import { verifyQstashSignature } from '@/lib/qstash/verify'
import { createAdminClient } from '@/lib/supabase/admin'
import { runReplyForInbound } from '@/lib/pipeline/reply'
import { isAppError } from '@/lib/errors/app-error'
import { getEmailById } from '@/lib/db/emails'
import { logError } from '@/lib/events/log-event'

export const runtime = 'nodejs'

const bodySchema = z.object({ emailId: z.string().uuid() })

export async function POST(request: Request) {
  let emailId: string | null = null
  try {
    const rawBody = await verifyQstashSignature(request)
    let json: unknown
    try {
      json = JSON.parse(rawBody)
    } catch {
      return NextResponse.json({ error: 'validation_error' }, { status: 400 })
    }
    const parsed = bodySchema.safeParse(json)
    if (!parsed.success) {
      return NextResponse.json({ error: 'validation_error' }, { status: 400 })
    }
    emailId = parsed.data.emailId
    const admin = createAdminClient()
    const summary = await runReplyForInbound(admin, parsed.data)
    return NextResponse.json({ ok: true, summary })
  } catch (error) {
    if (isAppError(error) && error.code === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }
    await logError({
      clientId: await resolveEmailClientId(emailId),
      actor: 'system',
      type: 'inbound.reply.route_failed',
      source: 'pipeline',
      error,
      payload: { emailId },
    })
    return NextResponse.json({ error: 'internal' }, { status: 500 })
  }
}

/**
 * Error-path only: `runReplyForInbound` owns the email lookup on the happy
 * path. Returns null rather than throwing so a lookup failure cannot replace
 * the original error.
 */
async function resolveEmailClientId(emailId: string | null): Promise<string | null> {
  if (!emailId) return null
  try {
    const email = await getEmailById(createAdminClient(), emailId)
    return email?.client_id ?? null
  } catch {
    return null
  }
}
