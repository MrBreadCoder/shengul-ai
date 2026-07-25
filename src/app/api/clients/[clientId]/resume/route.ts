import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth/require-user'
import { createAdminClient } from '@/lib/supabase/admin'
import { getClientById, updateClientStatus, listClientRoleAppUsers } from '@/lib/db/clients'
import { resumeCampaignsForClient } from '@/lib/db/campaigns'
import { unbanAuthUsers } from '@/lib/supabase/auth-admin'
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
    await resumeCampaignsForClient(admin, clientId)

    if (client.status === 'archived') {
      const appUsers = await listClientRoleAppUsers(admin)
      const userIds = appUsers.filter((row) => row.client_id === clientId).map((row) => row.id)
      await unbanAuthUsers(admin, userIds)
    }

    const updated = await updateClientStatus(admin, clientId, 'active')
    try {
      await logEvent({
        clientId,
        actor: `human:${appUser.id}`,
        type: 'client.resumed',
        payload: { from: client.status },
      })
    } catch {
      // Audit logging is best-effort — the resume already succeeded.
    }
    return NextResponse.json({ ok: true, client: updated })
  } catch (error) {
    const code = isAppError(error) ? error.code : 'unknown'
    return NextResponse.json({ error: code }, { status: 500 })
  }
}
