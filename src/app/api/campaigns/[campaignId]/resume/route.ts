import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth/require-user'
import { createAdminClient } from '@/lib/supabase/admin'
import { getCampaignById, updateCampaignStatus, recomputeCampaignNextDiscoverAt } from '@/lib/db/campaigns'
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
  if (campaign.status !== 'paused') {
    return NextResponse.json({ error: 'invalid_status' }, { status: 400 })
  }

  try {
    await updateCampaignStatus(admin, campaignId, 'active')
    // Recomputed from "now" rather than the status update's return value —
    // a campaign paused for days must not fire on the very next scheduler
    // tick from a next_discover_at left over from before it was paused.
    const updated = await recomputeCampaignNextDiscoverAt(admin, campaignId)
    try {
      await logEvent({
        clientId: campaign.client_id,
        actor: `human:${appUser.id}`,
        type: 'campaign.resumed',
        payload: { campaignId, name: campaign.name },
      })
    } catch {
      // Audit logging is best-effort — the resume already succeeded.
    }
    return NextResponse.json({ ok: true, campaign: updated })
  } catch (error) {
    const code = isAppError(error) ? error.code : 'unknown'
    return NextResponse.json({ error: code }, { status: 500 })
  }
}
