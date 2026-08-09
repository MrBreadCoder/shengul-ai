import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireUser } from '@/lib/auth/require-user'
import { createAdminClient } from '@/lib/supabase/admin'
import { updateEmailStyle, setDefaultEmailStyle, deleteEmailStyle } from '@/lib/db/email-styles'
import { logEvent } from '@/lib/events/log-event'
import { isAppError } from '@/lib/errors/app-error'

export const runtime = 'nodejs'

const nameSchema = z.string().trim().min(1).max(80)
const voiceInstructionsSchema = z.string().trim().min(1).max(4000)

const patchSchema = z
  .object({
    name: nameSchema.optional(),
    voiceInstructions: voiceInstructionsSchema.optional(),
    isDefault: z.literal(true).optional(),
  })
  .refine(
    (body) => body.name !== undefined || body.voiceInstructions !== undefined || body.isDefault !== undefined,
    { message: 'At least one field must be provided' },
  )
  .refine(
    (body) => !(body.isDefault !== undefined && (body.name !== undefined || body.voiceInstructions !== undefined)),
    { message: 'isDefault cannot be combined with name or voiceInstructions' },
  )

export async function PATCH(
  request: Request,
  context: { params: Promise<{ styleId: string }> },
): Promise<NextResponse> {
  const { appUser } = await requireUser()
  if (appUser.role !== 'operator') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  const { styleId } = await context.params
  const admin = createAdminClient()

  try {
    const body = patchSchema.parse(await request.json())
    const style = body.isDefault
      ? await setDefaultEmailStyle(admin, styleId)
      : await updateEmailStyle(admin, styleId, { name: body.name, voiceInstructions: body.voiceInstructions })

    try {
      await logEvent({
        clientId: null,
        actor: `human:${appUser.id}`,
        type: body.isDefault ? 'email_style.default_changed' : 'email_style.updated',
        payload: { id: style.id, name: style.name },
      })
    } catch {
      // Audit logging is best-effort — the update already succeeded.
    }
    return NextResponse.json({ ok: true, style })
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'validation_error', issues: error.flatten() }, { status: 400 })
    }
    if (isAppError(error) && error.code === 'EMAIL_STYLE_NAME_TAKEN') {
      return NextResponse.json({ error: 'name_taken' }, { status: 409 })
    }
    if (isAppError(error) && error.code === 'EMAIL_STYLE_NOT_FOUND') {
      return NextResponse.json({ error: 'not_found' }, { status: 404 })
    }
    const code = isAppError(error) ? error.code : 'unknown'
    return NextResponse.json({ error: code }, { status: 500 })
  }
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ styleId: string }> },
): Promise<NextResponse> {
  const { appUser } = await requireUser()
  if (appUser.role !== 'operator') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  const { styleId } = await context.params
  const admin = createAdminClient()

  try {
    await deleteEmailStyle(admin, styleId)
    try {
      await logEvent({
        clientId: null,
        actor: `human:${appUser.id}`,
        type: 'email_style.deleted',
        payload: { id: styleId },
      })
    } catch {
      // Audit logging is best-effort — the delete already succeeded.
    }
    return NextResponse.json({ ok: true })
  } catch (error) {
    if (isAppError(error) && error.code === 'CANNOT_DELETE_DEFAULT_STYLE') {
      return NextResponse.json({ error: 'cannot_delete_default_style' }, { status: 409 })
    }
    if (isAppError(error) && error.code === 'EMAIL_STYLE_NOT_FOUND') {
      return NextResponse.json({ error: 'not_found' }, { status: 404 })
    }
    const code = isAppError(error) ? error.code : 'unknown'
    return NextResponse.json({ error: code }, { status: 500 })
  }
}
