import { NextResponse } from 'next/server'
import { z } from 'zod'
import { verifyQstashSignature } from '@/lib/qstash/verify'
import { createAdminClient } from '@/lib/supabase/admin'
import { getMailboxById } from '@/lib/db/mailboxes'
import { ingestInboundForMailbox } from '@/lib/pipeline/inbound'
import { isAppError } from '@/lib/errors/app-error'

export const runtime = 'nodejs'

const bodySchema = z.object({ mailboxId: z.string().uuid() })

export async function POST(request: Request) {
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
    const admin = createAdminClient()
    const mailbox = await getMailboxById(admin, parsed.data.mailboxId)
    if (!mailbox) return NextResponse.json({ error: 'mailbox_not_found' }, { status: 404 })

    const summary = await ingestInboundForMailbox(admin, mailbox)
    return NextResponse.json({ ok: true, summary })
  } catch (error) {
    if (isAppError(error) && error.code === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }
    return NextResponse.json({ error: 'internal' }, { status: 500 })
  }
}
