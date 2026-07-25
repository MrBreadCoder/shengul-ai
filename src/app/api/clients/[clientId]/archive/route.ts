import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth/require-user'
import { createAdminClient } from '@/lib/supabase/admin'
import { getClientById, updateClientStatus, listClientRoleAppUsers } from '@/lib/db/clients'
import { pauseActiveCampaignsForClient } from '@/lib/db/campaigns'
import { banAuthUsers } from '@/lib/supabase/auth-admin'
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

    const appUsers = await listClientRoleAppUsers(admin)
    const userIds = appUsers.filter((row) => row.client_id === clientId).map((row) => row.id)
    await banAuthUsers(admin, userIds)

    const updated = await updateClientStatus(admin, clientId, 'archived')
    try {
      await logEvent({
        clientId,
        actor: `human:${appUser.id}`,
        type: 'client.archived',
        payload: { bannedUserCount: userIds.length },
      })
    } catch {
      // Audit logging is best-effort — the archive already succeeded.
    }
    return NextResponse.json({ ok: true, client: updated })
  } catch (error) {
    const code = isAppError(error) ? error.code : 'unknown'
    return NextResponse.json({ error: code }, { status: 500 })
  }
}
