import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireUser } from '@/lib/auth/require-user'
import { createAdminClient } from '@/lib/supabase/admin'
import { insertClient } from '@/lib/db/clients'
import { logEvent } from '@/lib/events/log-event'
import { isAppError } from '@/lib/errors/app-error'

export const runtime = 'nodejs'

const createClientSchema = z.object({
  name: z.string().min(1),
})

export async function POST(request: Request) {
  const { appUser } = await requireUser()
  if (appUser.role !== 'operator') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  try {
    const body = createClientSchema.parse(await request.json())
    const admin = createAdminClient()
    const client = await insertClient(admin, { name: body.name })
    try {
      await logEvent({
        clientId: client.id,
        actor: `human:${appUser.id}`,
        type: 'client.created',
        payload: { name: client.name },
      })
    } catch {
      // Audit logging is best-effort — the client was already created successfully.
    }
    return NextResponse.json({ ok: true, client })
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'validation_error', issues: error.flatten() }, { status: 400 })
    }
    const code = isAppError(error) ? error.code : 'unknown'
    return NextResponse.json({ error: code }, { status: 500 })
  }
}
