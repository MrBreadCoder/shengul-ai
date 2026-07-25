import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth/require-user'
import { createAdminClient } from '@/lib/supabase/admin'
import { getClientById, updateClientLogoUrl } from '@/lib/db/clients'
import { uploadClientLogo, deleteClientLogoObject } from '@/lib/storage/logos'
import { logEvent } from '@/lib/events/log-event'
import { isAppError } from '@/lib/errors/app-error'

export const runtime = 'nodejs'

// Operator-only, same pattern as every other client-mutating route in this
// app: check role, load the client, act, best-effort audit log.
export async function POST(request: Request, context: { params: Promise<{ clientId: string }> }) {
  const { appUser } = await requireUser()
  if (appUser.role !== 'operator') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const { clientId } = await context.params
  const admin = createAdminClient()
  const client = await getClientById(admin, clientId)
  if (!client) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }

  try {
    const formData = await request.formData()
    const file = formData.get('file')
    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'validation_error', issues: 'file is required' }, { status: 400 })
    }

    const logoUrl = await uploadClientLogo(admin, clientId, file)
    const updated = await updateClientLogoUrl(admin, clientId, logoUrl)

    // Best-effort: drop the previous object now that the new one is live and
    // the DB points at it. Awaited — a serverless function can be frozen or
    // torn down the instant the response is sent, so an un-awaited cleanup
    // call here could simply never run.
    if (client.logo_url) await deleteClientLogoObject(admin, client.logo_url)

    try {
      await logEvent({
        clientId,
        actor: `human:${appUser.id}`,
        type: 'client.logo_uploaded',
        payload: { logoUrl },
      })
    } catch {
      // Audit logging is best-effort — the upload already succeeded.
    }

    return NextResponse.json({ ok: true, client: updated })
  } catch (error) {
    if (isAppError(error) && error.code === 'VALIDATION_ERROR') {
      return NextResponse.json({ error: 'validation_error', issues: error.message }, { status: 400 })
    }
    const code = isAppError(error) ? error.code : 'unknown'
    return NextResponse.json({ error: code }, { status: 500 })
  }
}

// Reverts to the domain favicon (or initials, if no domain is set) by
// clearing logo_url and best-effort deleting the stored object.
export async function DELETE(_request: Request, context: { params: Promise<{ clientId: string }> }) {
  const { appUser } = await requireUser()
  if (appUser.role !== 'operator') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const { clientId } = await context.params
  const admin = createAdminClient()
  const client = await getClientById(admin, clientId)
  if (!client) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }
  if (!client.logo_url) {
    return NextResponse.json({ ok: true, client })
  }

  try {
    const updated = await updateClientLogoUrl(admin, clientId, null)
    await deleteClientLogoObject(admin, client.logo_url)

    try {
      await logEvent({
        clientId,
        actor: `human:${appUser.id}`,
        type: 'client.logo_removed',
        payload: {},
      })
    } catch {
      // Audit logging is best-effort — the removal already succeeded.
    }

    return NextResponse.json({ ok: true, client: updated })
  } catch (error) {
    const code = isAppError(error) ? error.code : 'unknown'
    return NextResponse.json({ error: code }, { status: 500 })
  }
}
