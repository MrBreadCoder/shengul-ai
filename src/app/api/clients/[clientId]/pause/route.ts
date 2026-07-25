import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth/require-user'
import { createAdminClient } from '@/lib/supabase/admin'
import { getClientById, updateClientStatus } from '@/lib/db/clients'
import { pauseActiveCampaignsForClient } from '@/lib/db/campaigns'
import { logEvent } from '@/lib/events/log-event'
import { isAppError } from '@/lib/errors/app-error'

export const runtime = 'nodejs'

export async function POST(_request: Request, context: { params: Promise<{ clientId: string }> }) {
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
    await pauseActiveCampaignsForClient(admin, clientId)
    const updated = await updateClientStatus(admin, clientId, 'paused')
    try {
      await logEvent({ clientId, actor: `human:${appUser.id}`, type: 'client.paused', payload: {} })
    } catch {
      // Audit logging is best-effort — the pause already succeeded.
    }
    return NextResponse.json({ ok: true, client: updated })
  } catch (error) {
    const code = isAppError(error) ? error.code : 'unknown'
    return NextResponse.json({ error: code }, { status: 500 })
  }
}
