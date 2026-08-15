import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireUser } from '@/lib/auth/require-user'
import { createAdminClient } from '@/lib/supabase/admin'
import { listEmailTemplates, createEmailTemplate } from '@/lib/db/email-templates'
import { logEvent } from '@/lib/events/log-event'
import { isAppError } from '@/lib/errors/app-error'

export const runtime = 'nodejs'

const nameSchema = z.string().trim().min(1).max(80)
const templateTextSchema = z.string().trim().min(1).max(4000)

const createSchema = z.object({
  name: nameSchema,
  templateText: templateTextSchema,
})

export async function GET(): Promise<NextResponse> {
  const { appUser } = await requireUser()
  if (appUser.role !== 'operator') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  const admin = createAdminClient()
  const templates = await listEmailTemplates(admin)
  return NextResponse.json({ templates })
}

export async function POST(request: Request): Promise<NextResponse> {
  const { appUser } = await requireUser()
  if (appUser.role !== 'operator') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  const admin = createAdminClient()

  try {
    const body = createSchema.parse(await request.json())
    const template = await createEmailTemplate(admin, body)
    try {
      await logEvent({
        clientId: null,
        actor: `human:${appUser.id}`,
        type: 'email_template.created',
        payload: { id: template.id, name: template.name },
      })
    } catch {
      // Audit logging is best-effort — the create already succeeded.
    }
    return NextResponse.json({ ok: true, template }, { status: 201 })
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'validation_error', issues: error.flatten() }, { status: 400 })
    }
    if (isAppError(error) && error.code === 'EMAIL_TEMPLATE_NAME_TAKEN') {
      return NextResponse.json({ error: 'name_taken' }, { status: 409 })
    }
    const code = isAppError(error) ? error.code : 'unknown'
    return NextResponse.json({ error: code }, { status: 500 })
  }
}
