import { NextResponse } from 'next/server'
import { z } from 'zod'
import { verifyQstashSignature } from '@/lib/qstash/verify'
import { createAdminClient } from '@/lib/supabase/admin'
import { getCaseById, updateCaseStatus } from '@/lib/db/cases'
import { listActiveLeadsForCase } from '@/lib/db/leads'
import { getCampaignForCase } from '@/lib/db/campaigns'
import { getClientById } from '@/lib/db/clients'
import { runResearchForCase } from '@/lib/pipeline/research'
import { brightdataResearch } from '@/lib/research/brightdata'
import { isAppError } from '@/lib/errors/app-error'
import { isModelOverloadedError } from '@/lib/llm/client'
import { handleModelOverload } from '@/lib/pipeline/overload-retry'
import { logError } from '@/lib/events/log-event'
import { parseCompanyFirmographicsFromRaw, parseCompanySocialsFromRaw, parsePersonSocialsFromRaw } from '@/lib/apollo/format-company-summary'

export const runtime = 'nodejs'

const bodySchema = z.object({
  caseId: z.string().uuid(),
  // Absent on the first attempt (fanout/direct-trigger publishes never set
  // it) — only present when this delivery is itself an overload long-retry
  // scheduled by handleModelOverload below.
  retryCount: z.number().int().min(0).optional(),
})

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
    // Every active lead on a case shares one company, so any lead's `raw`
    // carries the same Apollo org match — the first lead is enough.
    const companyFirmographics = leads[0] ? parseCompanyFirmographicsFromRaw(leads[0].raw) : null
    const companySocials = leads[0] ? parseCompanySocialsFromRaw(leads[0].raw) : { linkedinUrl: null, twitterUrl: null }
    // Missing client row never blocks research — same "degrade, don't
    // fail" stance write.ts takes for the same lookup — the agent just gets
    // less to filter against (sellerContextLine omits itself when every
    // field is null).
    const client = await getClientById(admin, kase.client_id)

    try {
      const summary = await runResearchForCase(
        admin,
        { research: brightdataResearch },
        {
          clientId: kase.client_id,
          caseId: parsedBody.caseId,
          companyName: kase.company_name,
          companyDomain: kase.company_domain,
          companyFirmographics,
          companySocials,
          leads: leads.map((l) => {
            const { twitterUrl } = parsePersonSocialsFromRaw(l.raw)
            return { id: l.id, fullName: l.full_name, title: l.title, linkedinUrl: l.linkedin_url, twitterUrl }
          }),
          seller: {
            name: client?.name ?? null,
            companyInfo: client?.company_info ?? null,
            valueProp: campaign.value_prop,
          },
        },
      )
      return NextResponse.json({ ok: true, summary })
    } catch (researchError) {
      // A Gemini overload gets a long, delayed retry instead of the normal
      // failure path — see overload-retry.ts. Every other failure falls
      // through to the outer catch unchanged (case stays 'researching' for
      // stuck-sweep to eventually recover).
      if (!isModelOverloadedError(researchError)) throw researchError
      const outcome = await handleModelOverload({
        path: '/api/pipeline/research',
        caseId: parsedBody.caseId,
        clientId,
        actor: 'system',
        eventPrefix: 'pipeline.research',
        retryCount: parsedBody.retryCount ?? 0,
        error: researchError,
        revert: () => updateCaseStatus(admin, parsedBody.caseId, 'new'),
      })
      return NextResponse.json({ ok: true, overload: outcome })
    }
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
