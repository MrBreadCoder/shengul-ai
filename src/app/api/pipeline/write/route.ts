import { NextResponse } from 'next/server'
import { z } from 'zod'
import { verifyQstashSignature } from '@/lib/qstash/verify'
import { createAdminClient } from '@/lib/supabase/admin'
import { getCaseById, updateCaseStatus, claimCaseForWriting, AUTO_RETRY_WAIT_REASONS } from '@/lib/db/cases'
import { getCampaignForCase } from '@/lib/db/campaigns'
import { runWriteForCase } from '@/lib/pipeline/write'
import { isAppError } from '@/lib/errors/app-error'
import { isModelOverloadedError } from '@/lib/llm/client'
import { handleModelOverload } from '@/lib/pipeline/overload-retry'
import { logError } from '@/lib/events/log-event'

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
    const resumable = kase.status === 'ready'
      || (kase.status === 'waiting' && kase.wait_reason !== null && AUTO_RETRY_WAIT_REASONS.includes(kase.wait_reason))
    if (!resumable) return NextResponse.json({ ok: true, skipped: 'case_not_ready' })

    const campaign = await getCampaignForCase(admin, caseId)
    if (!campaign || campaign.status !== 'active') {
      return NextResponse.json({ ok: true, skipped: 'campaign_not_active' })
    }

    // Atomic claim, not the read-then-write the `resumable` check above (now
    // just a fast-path early-exit) used to pair with an unconditional
    // status write: a retried/concurrent delivery for the same case (a
    // retried QStash message racing the original, or overlapping fanout
    // ticks) must not both pass `resumable` and then both flip the case to
    // 'writing' — only the update that actually transitions a still-
    // eligible row wins and proceeds to runWriteForCase. 'writing' is a
    // genuine in-progress status distinct from the terminal 'contacted'
    // write.ts sets only once the leads loop actually finishes — claiming
    // 'contacted' up front (the old behavior) meant any failure mid-write
    // left the case permanently reading 'contacted' with zero emails sent.
    // See .claude/roadmap.md 2026-08-12 "False 'contacted' status on write
    // failure".
    const claimed = await claimCaseForWriting(admin, caseId)
    if (!claimed) return NextResponse.json({ ok: true, skipped: 'case_not_ready' })

    try {
      const summary = await runWriteForCase(admin, {
        clientId: kase.client_id,
        campaignId: campaign.id,
        caseId: parsedBody.caseId,
        replyMode: campaign.reply_mode,
        valueProp: campaign.value_prop,
        bookingLink: campaign.booking_link,
        mailboxIds: campaign.mailbox_ids,
        companyName: kase.company_name,
        signatureName: campaign.signature_name,
        signatureTitle: campaign.signature_title,
        signaturePhone: campaign.phone,
        signatureAddress: campaign.address,
        campaignEmailTemplateId: campaign.email_template_id,
        currentStatus: kase.status,
        currentWaitReason: kase.wait_reason,
      })
      return NextResponse.json({ ok: true, summary })
    } catch (writeError) {
      // A Gemini overload gets a long, delayed retry instead of the normal
      // failure path — see overload-retry.ts. Every other failure falls
      // through to the outer catch unchanged (case stays 'writing' for
      // stuck-sweep to eventually recover).
      if (!isModelOverloadedError(writeError)) throw writeError
      const outcome = await handleModelOverload({
        path: '/api/pipeline/write',
        caseId: parsedBody.caseId,
        clientId,
        actor: 'system',
        eventPrefix: 'pipeline.write',
        retryCount: parsedBody.retryCount ?? 0,
        error: writeError,
        revert: () => updateCaseStatus(admin, parsedBody.caseId, 'ready'),
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
      type: 'pipeline.write.route_failed',
      source: 'pipeline',
      error,
    })
    return NextResponse.json({ error: 'internal' }, { status: 500 })
  }
}
