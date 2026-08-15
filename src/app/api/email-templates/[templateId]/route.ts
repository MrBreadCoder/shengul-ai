import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireUser } from '@/lib/auth/require-user'
import { createAdminClient } from '@/lib/supabase/admin'
import { updateEmailTemplate, setDefaultEmailTemplate, deleteEmailTemplate } from '@/lib/db/email-templates'
import { logEvent } from '@/lib/events/log-event'
import { isAppError } from '@/lib/errors/app-error'

export const runtime = 'nodejs'

const nameSchema = z.string().trim().min(1).max(80)
const templateTextSchema = z.string().trim().min(1).max(4000)

const patchSchema = z
  .object({
    name: nameSchema.optional(),
    templateText: templateTextSchema.optional(),
    isDefault: z.literal(true).optional(),
  })
  .refine(
    (body) => body.name !== undefined || body.templateText !== undefined || body.isDefault !== undefined,
    { message: 'At least one field must be provided' },
  )
  .refine(
    (body) => !(body.isDefault !== undefined && (body.name !== undefined || body.templateText !== undefined)),
    { message: 'isDefault cannot be combined with name or templateText' },
  )

export async function PATCH(
  request: Request,
  context: { params: Promise<{ templateId: string }> },
): Promise<NextResponse> {
  const { appUser } = await requireUser()
  if (appUser.role !== 'operator') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  const { templateId } = await context.params
  const admin = createAdminClient()

  try {
    const body = patchSchema.parse(await request.json())
    const template = body.isDefault
      ? await setDefaultEmailTemplate(admin, templateId)
      : await updateEmailTemplate(admin, templateId, { name: body.name, templateText: body.templateText })

    try {
      await logEvent({
        clientId: null,
        actor: `human:${appUser.id}`,
        type: body.isDefault ? 'email_template.default_changed' : 'email_template.updated',
        payload: { id: template.id, name: template.name },
      })
    } catch {
      // Audit logging is best-effort — the update already succeeded.
    }
    return NextResponse.json({ ok: true, template })
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'validation_error', issues: error.flatten() }, { status: 400 })
    }
    if (isAppError(error) && error.code === 'EMAIL_TEMPLATE_NAME_TAKEN') {
      return NextResponse.json({ error: 'name_taken' }, { status: 409 })
    }
    if (isAppError(error) && error.code === 'EMAIL_TEMPLATE_NOT_FOUND') {
      return NextResponse.json({ error: 'not_found' }, { status: 404 })
    }
    const code = isAppError(error) ? error.code : 'unknown'
    return NextResponse.json({ error: code }, { status: 500 })
  }
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ templateId: string }> },
): Promise<NextResponse> {
  const { appUser } = await requireUser()
  if (appUser.role !== 'operator') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  const { templateId } = await context.params
  const admin = createAdminClient()

  try {
    await deleteEmailTemplate(admin, templateId)
    try {
      await logEvent({
        clientId: null,
        actor: `human:${appUser.id}`,
        type: 'email_template.deleted',
        payload: { id: templateId },
      })
    } catch {
      // Audit logging is best-effort — the delete already succeeded.
    }
    return NextResponse.json({ ok: true })
  } catch (error) {
    if (isAppError(error) && error.code === 'CANNOT_DELETE_DEFAULT_TEMPLATE') {
      return NextResponse.json({ error: 'cannot_delete_default_template' }, { status: 409 })
    }
    if (isAppError(error) && error.code === 'EMAIL_TEMPLATE_NOT_FOUND') {
      return NextResponse.json({ error: 'not_found' }, { status: 404 })
    }
    const code = isAppError(error) ? error.code : 'unknown'
    return NextResponse.json({ error: code }, { status: 500 })
  }
}
