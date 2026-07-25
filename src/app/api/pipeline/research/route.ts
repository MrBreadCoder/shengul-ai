import { NextResponse } from 'next/server'
import { z } from 'zod'
import { verifyQstashSignature } from '@/lib/qstash/verify'
import { createAdminClient } from '@/lib/supabase/admin'
import { getCaseById, updateCaseStatus } from '@/lib/db/cases'
import { listActiveLeadsForCase } from '@/lib/db/leads'
import { getCampaignForCase } from '@/lib/db/campaigns'
import { runResearchForCase } from '@/lib/pipeline/research'
import { brightdataResearch } from '@/lib/research/brightdata'
import { isAppError } from '@/lib/errors/app-error'
import { logError } from '@/lib/events/log-event'

export const runtime = 'nodejs'

const bodySchema = z.object({ caseId: z.string().uuid() })

export async function POST(request: Request) {
  // Captured as the handler progresses so the catch block can attribute the
  // failure. Stays null only for failures that happen before we know which
  // client this job belongs to (signature/parse errors).
  let clientId: string | null = null
  let caseId: string | null = null
  try {
    const rawBody = await verifyQstashSignature(request)
    const parsedBody = bodySchema.parse(JSON.parse(rawBody))
    caseId = parsedBody.caseId
    const admin = createAdminClient()

    const kase = await getCaseById(admin, caseId)
    if (!kase) return NextResponse.json({ error: 'case_not_found' }, { status: 404 })
    clientId = kase.client_id
    if (kase.status !== 'new') return NextResponse.json({ ok: true, skipped: 'case_not_new' })

    const campaign = await getCampaignForCase(admin, caseId)
    if (!campaign || campaign.status !== 'active') {
      return NextResponse.json({ ok: true, skipped: 'campaign_not_active' })
    }

    // Claim the case so a concurrent/retried fan-out won't re-research it.
    await updateCaseStatus(admin, caseId, 'researching')

    const leads = await listActiveLeadsForCase(admin, caseId)
    const summary = await runResearchForCase(
      admin,
      { research: brightdataResearch },
      {
        clientId: kase.client_id,
        caseId,
        companyName: kase.company_name,
        companyDomain: kase.company_domain,
        valueProp: campaign.value_prop,
        leads: leads.map((l) => ({ fullName: l.full_name, title: l.title })),
      },
    )
    return NextResponse.json({ ok: true, summary })
  } catch (error) {
    if (isAppError(error) && error.code === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }
    await logError({
      clientId,
      caseId,
      actor: 'system',
      type: 'pipeline.research.route_failed',
      source: 'pipeline',
      error,
    })
    return NextResponse.json({ error: 'internal' }, { status: 500 })
  }
}
