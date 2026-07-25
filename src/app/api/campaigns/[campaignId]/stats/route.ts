import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth/require-user'
import { createAdminClient } from '@/lib/supabase/admin'
import { getCampaignById } from '@/lib/db/campaigns'
import { countCasesForCampaign } from '@/lib/db/cases'
import { countLeadsForCampaign } from '@/lib/db/leads'
import { isAppError } from '@/lib/errors/app-error'

export const runtime = 'nodejs'

export async function GET(_request: Request, context: { params: Promise<{ campaignId: string }> }) {
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

  try {
    const [caseCount, leadCount] = await Promise.all([
      countCasesForCampaign(admin, campaignId),
      countLeadsForCampaign(admin, campaignId),
    ])
    return NextResponse.json({ ok: true, caseCount, leadCount })
  } catch (error) {
    const code = isAppError(error) ? error.code : 'unknown'
    return NextResponse.json({ error: code }, { status: 500 })
  }
}
