import { NextResponse } from 'next/server'
import { verifyQstashSignature } from '@/lib/qstash/verify'
import { createAdminClient } from '@/lib/supabase/admin'
import { listCampaignsDueForDiscovery, recomputeCampaignNextDiscoverAt } from '@/lib/db/campaigns'
import { publishJson } from '@/lib/qstash/client'
import { logEvent } from '@/lib/events/log-event'
import { isAppError } from '@/lib/errors/app-error'

export const runtime = 'nodejs'

export async function POST(request: Request) {
  try {
    await verifyQstashSignature(request)
    const admin = createAdminClient()
    const now = new Date()
    const campaigns = await listCampaignsDueForDiscovery(admin, now.toISOString())
    const firedCampaignIds: string[] = []
    const failedCampaignIds: string[] = []
    const staleScheduleCampaignIds: string[] = []

    for (const campaign of campaigns) {
      let published = false
      try {
        await publishJson('/api/pipeline/discover', { campaignId: campaign.id })
        published = true
        firedCampaignIds.push(campaign.id)
      } catch {
        // Isolate per-campaign publish failures — one bad QStash publish
        // doesn't stop the rest of the due campaigns. Left due; retried on
        // the next 5-minute tick instead of waiting a full day.
        failedCampaignIds.push(campaign.id)
      }

      if (published) {
        try {
          await recomputeCampaignNextDiscoverAt(admin, campaign.id, now)
        } catch {
          // The discover job already published successfully — this is
          // deliberately NOT added to failedCampaignIds. Doing so would make
          // the next tick re-publish a second, duplicate discover run for a
          // campaign that already fired. A stuck next_discover_at here is
          // caught by the next client-settings save or campaign edit, both
          // of which recompute it unconditionally.
          staleScheduleCampaignIds.push(campaign.id)
        }
      }
    }

    try {
      await logEvent({
        clientId: null,
        actor: 'system',
        type: 'pipeline.discover_fanout.completed',
        payload: { campaignCount: campaigns.length, firedCampaignIds, failedCampaignIds, staleScheduleCampaignIds },
      })
    } catch {
      // Audit logging is best-effort — it must not turn a completed fanout
      // into a 500 response.
    }
    return NextResponse.json({
      ok: true,
      campaignCount: campaigns.length,
      firedCampaignIds,
      failedCampaignIds,
      staleScheduleCampaignIds,
    })
  } catch (error) {
    if (isAppError(error) && error.code === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }
    return NextResponse.json({ error: 'internal' }, { status: 500 })
  }
}
