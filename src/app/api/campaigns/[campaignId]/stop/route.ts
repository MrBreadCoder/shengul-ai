import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth/require-user'
import { createAdminClient } from '@/lib/supabase/admin'
import { getCampaignById, updateCampaignStatus } from '@/lib/db/campaigns'
import { logEvent } from '@/lib/events/log-event'
import { isAppError } from '@/lib/errors/app-error'

export const runtime = 'nodejs'

export async function POST(_request: Request, context: { params: Promise<{ campaignId: string }> }) {
  const { appUser } = await requireUser()
  if (appUser.role !== 'operator') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const { campaignId } = await context.params
  const admin = createAdminClient()
  const campaign = await getCampaignById(admin, campaignId)
  if (!campaign) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }
  if (campaign.status !== 'active') {
    return NextResponse.json({ error: 'invalid_status' }, { status: 400 })
  }

  try {
    const updated = await updateCampaignStatus(admin, campaignId, 'paused')
    try {
      await logEvent({
        clientId: campaign.client_id,
        actor: `human:${appUser.id}`,
        type: 'campaign.stopped',
        payload: { campaignId, name: campaign.name },
      })
    } catch {
      // Audit logging is best-effort — the stop already succeeded.
    }
    return NextResponse.json({ ok: true, campaign: updated })
  } catch (error) {
    const code = isAppError(error) ? error.code : 'unknown'
    return NextResponse.json({ error: code }, { status: 500 })
  }
}
