import { NextResponse } from 'next/server'
import { verifyQstashSignature } from '@/lib/qstash/verify'
import { createAdminClient } from '@/lib/supabase/admin'
import { listActiveCampaigns } from '@/lib/db/campaigns'
import { publishJson } from '@/lib/qstash/client'
import { logEvent } from '@/lib/events/log-event'
import { isAppError } from '@/lib/errors/app-error'

export const runtime = 'nodejs'

export async function POST(request: Request) {
  try {
    await verifyQstashSignature(request)
    const admin = createAdminClient()
    const campaigns = await listActiveCampaigns(admin)
    const failedCampaignIds: string[] = []
    for (const campaign of campaigns) {
      try {
        await publishJson('/api/pipeline/discover', { campaignId: campaign.id })
      } catch {
        // Isolate per-campaign publish failures so one bad QStash publish
        // doesn't stop the remaining active campaigns from being enqueued.
        failedCampaignIds.push(campaign.id)
      }
    }
    try {
      await logEvent({
        clientId: null,
        actor: 'system',
        type: 'pipeline.discover_fanout.completed',
        payload: { campaignCount: campaigns.length, failedCampaignIds },
      })
    } catch {
      // Audit logging is best-effort — it must not turn a completed fanout
      // into a 500 response.
    }
    return NextResponse.json({
      ok: true,
      campaignCount: campaigns.length,
      failedCampaignIds,
    })
  } catch (error) {
    if (isAppError(error) && error.code === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }
    return NextResponse.json({ error: 'internal' }, { status: 500 })
  }
}
