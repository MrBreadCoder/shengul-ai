'use server'

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { requireUser } from '@/lib/auth/require-user'
import { createAdminClient } from '@/lib/supabase/admin'
import {
  getEmailById,
  claimDraftForSend,
  markEmailSent,
  markEmailFailed,
  hasReplyForInbound,
} from '@/lib/db/emails'
import { getCampaignForCase } from '@/lib/db/campaigns'
import { getLeadById } from '@/lib/db/leads'
import { sendViaMailbox } from '@/lib/mailbox/sender'
import { FIRST_TOUCH_STEP, scheduleFirstFollowup } from '@/lib/pipeline/followup'
import { AppError } from '@/lib/errors/app-error'
import { logEventSafe } from '@/lib/events/log-event'
import { claimKnowledgeRequestAnswer, getKnowledgeRequestById } from '@/lib/db/knowledge-requests'
import { insertKnowledge } from '@/lib/db/case-knowledge'
import { runKnowledgeAnswer } from '@/lib/pipeline/knowledge-answer'

const approveSchema = z.object({ emailId: z.string().uuid() })

export async function approveDraft(formData: FormData): Promise<void> {
  const { appUser } = await requireUser()
  // Sending live mail is operator-only. The pipeline routes gate on this same
  // check; without it a non-operator's click would trigger a SECURITY DEFINER
  // mailbox send while the RLS-blocked status write silently no-ops.
  if (appUser.role !== 'operator') {
    throw new AppError('UNAUTHORIZED', 'Only operators can approve drafts', { userId: appUser.id })
  }
  const { emailId } = approveSchema.parse({ emailId: formData.get('emailId') })

  // Admin client (bypasses RLS) for both read and write, matching every other
  // send path. The operator check above is the authorization boundary.
  const supabase = createAdminClient()

  const email = await getEmailById(supabase, emailId)
  if (!email || email.status !== 'draft' || email.direction !== 'outbound') {
    throw new AppError('VALIDATION_ERROR', 'Email is not an approvable draft', { emailId })
  }
  if (!email.case_id || !email.lead_id || !email.subject || !email.body) {
    throw new AppError('VALIDATION_ERROR', 'Draft is missing required fields', { emailId })
  }

  const lead = await getLeadById(supabase, email.lead_id)
  if (!lead?.email) throw new AppError('VALIDATION_ERROR', 'Lead has no email', { emailId })

  const campaign = await getCampaignForCase(supabase, email.case_id)
  if (!campaign) throw new AppError('NOT_FOUND', 'Campaign not found for case', { emailId })

  // Atomic claim BEFORE sending: draft -> queued. A concurrent invocation
  // (double-click, two tabs, a Server Action retry) that loses the race gets
  // null here and returns without sending a second real email.
  const claimed = await claimDraftForSend(supabase, email.id)
  if (!claimed) {
    revalidatePath('/inbox')
    return
  }

  try {
    const sent = await sendViaMailbox(supabase, {
      clientId: email.client_id,
      mailboxIds: campaign.mailbox_ids,
      to: lead.email,
      subject: email.subject,
      body: email.body,
      purpose: email.in_reply_to_email_id ? 'reply' : 'outreach',
    })
    await markEmailSent(supabase, email.id, {
      providerMessageId: sent.providerMessageId,
      threadId: sent.threadId,
      mailboxId: sent.mailboxId,
    })
  } catch (error) {
    try {
      await markEmailFailed(supabase, email.id)
    } catch {
      // Best-effort status write; the send error below is the one that matters.
    }
    revalidatePath('/inbox')
    throw error
  }

  // Mirror the automated write path: approving the first touch starts the
  // 3/7/14-day cadence. A later manual step must not start a second sequence.
  // Best-effort: the email already sent successfully, so a scheduling failure
  // here must not surface as a failed send to the operator.
  if (email.sequence_step === FIRST_TOUCH_STEP) {
    try {
      await scheduleFirstFollowup(supabase, {
        clientId: email.client_id,
        caseId: email.case_id,
        leadId: email.lead_id,
      })
    } catch (error) {
      await logEventSafe({
        clientId: email.client_id,
        caseId: email.case_id,
        actor: 'inbox_approve_draft',
        type: 'inbox.schedule_followup_failed',
        payload: { emailId: email.id, cause: error instanceof Error ? error.message : String(error) },
      })
    }
  }

  revalidatePath('/inbox')
}

const answerSchema = z.object({
  knowledgeRequestId: z.string().uuid(),
  answer: z.string().min(1),
})

// Operator supplies the previously-missing fact. We atomically claim the open
// request (open -> answered), store the fact as case_knowledge (kind 'answer',
// human-authored), then let the AI write + send the reply grounded on it.
export async function answerKnowledgeRequest(formData: FormData): Promise<void> {
  const { appUser } = await requireUser()
  if (appUser.role !== 'operator') {
    throw new AppError('UNAUTHORIZED', 'Only operators can answer knowledge requests', { userId: appUser.id })
  }
  const { knowledgeRequestId, answer } = answerSchema.parse({
    knowledgeRequestId: formData.get('knowledgeRequestId'),
    answer: formData.get('answer'),
  })

  const supabase = createAdminClient()

  const claimed = await claimKnowledgeRequestAnswer(supabase, {
    id: knowledgeRequestId,
    answer,
    answeredBy: appUser.id,
  })

  let kr = claimed
  if (!kr) {
    // The claim lost the race, which means the request is no longer 'open'.
    // That can be a genuine duplicate submit (already fully processed), but it
    // can also be a prior attempt that answered the request and then crashed
    // before insertKnowledge/runKnowledgeAnswer ran — leaving it stuck with no
    // fact recorded and no reply sent. Recover in that case only; a request
    // that already has a reply out is left alone (no-op).
    const existing = await getKnowledgeRequestById(supabase, knowledgeRequestId)
    const alreadyReplied = existing?.email_id ? await hasReplyForInbound(supabase, existing.email_id) : true
    if (!existing || existing.status !== 'answered' || alreadyReplied) {
      revalidatePath('/inbox')
      return
    }
    kr = existing
  }

  await insertKnowledge(supabase, [
    {
      client_id: kr.client_id,
      case_id: kr.case_id,
      kind: 'answer',
      content: answer,
      source_url: null,
      citation: null,
      created_by: 'human',
    },
  ])

  await runKnowledgeAnswer(supabase, { knowledgeRequestId: kr.id })
  revalidatePath('/inbox')
}
