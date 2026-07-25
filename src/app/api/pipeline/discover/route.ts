import { NextResponse } from 'next/server'
import { z } from 'zod'
import { verifyQstashSignature } from '@/lib/qstash/verify'
import { createAdminClient } from '@/lib/supabase/admin'
import { getCampaignById } from '@/lib/db/campaigns'
import { apolloIcpSchema } from '@/lib/apollo/types'
import { runDiscoveryForCampaign } from '@/lib/pipeline/discover'
import { isAppError } from '@/lib/errors/app-error'
import { logError } from '@/lib/events/log-event'

export const runtime = 'nodejs'

const bodySchema = z.object({ campaignId: z.string().uuid() })

export async function POST(request: Request) {
  // Captured as the handler progresses so the catch block can attribute the
  // failure. Stays null only for failures that happen before we know which
  // client this job belongs to (signature/parse errors).
  let clientId: string | null = null
  let campaignId: string | null = null
  try {
    const rawBody = await verifyQstashSignature(request)
    const parsedBody = bodySchema.parse(JSON.parse(rawBody))
    campaignId = parsedBody.campaignId

    const admin = createAdminClient()
    const campaign = await getCampaignById(admin, campaignId)
    if (!campaign) {
      return NextResponse.json({ error: 'campaign_not_found' }, { status: 404 })
    }
    clientId = campaign.client_id
    if (campaign.status !== 'active') {
      return NextResponse.json({ ok: true, skipped: 'campaign_not_active' })
    }

    const icp = apolloIcpSchema.parse(campaign.icp)
    const summary = await runDiscoveryForCampaign(admin, {
      id: campaign.id,
      clientId: campaign.client_id,
      dailyTarget: campaign.daily_target,
      icp,
    })
    return NextResponse.json({ ok: true, summary })
  } catch (error) {
    if (isAppError(error) && error.code === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }
    await logError({
      clientId,
      actor: 'system',
      type: 'pipeline.discover.route_failed',
      source: 'pipeline',
      error,
      payload: { campaignId },
    })
    return NextResponse.json({ error: 'internal' }, { status: 500 })
  }
}
