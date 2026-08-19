'use server'

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { requireUser } from '@/lib/auth/require-user'
import { canManageClient } from '@/lib/auth/can-manage-client'
import { createAdminClient } from '@/lib/supabase/admin'
import { createServerClient } from '@/lib/supabase/server'
import {
  getEmailById,
  claimDraftForSend,
  markEmailSent,
  markEmailFailed,
  hasReplyForInbound,
  updateDraftContent as updateDraftContentRow,
} from '@/lib/db/emails'
import { getCampaignForCase } from '@/lib/db/campaigns'
import { getLeadById } from '@/lib/db/leads'
import { claimCaseContacted, updateCaseWaiting } from '@/lib/db/cases'
import { getClientById } from '@/lib/db/clients'
import { enqueueCrmSync } from '@/lib/crm/sync'
import { sendViaMailbox } from '@/lib/mailbox/sender'
import { getOutreachEligibility } from '@/lib/mailbox/eligibility'
import { FIRST_TOUCH_STEP, scheduleFirstFollowup } from '@/lib/pipeline/followup'
import { AppError, isAppError } from '@/lib/errors/app-error'
import { logEventSafe } from '@/lib/events/log-event'
import { claimKnowledgeRequestAnswer, getKnowledgeRequestById } from '@/lib/db/knowledge-requests'
import { insertKnowledge } from '@/lib/db/case-knowledge'
import { runKnowledgeAnswer } from '@/lib/pipeline/knowledge-answer'
import { listAttachmentsForEmail, replaceEmailAttachments } from '@/lib/db/email-attachments'
import { loadResourceAttachments } from '@/lib/resources/load-attachments'
import { resolveSelectedResources } from '@/lib/resources/select'
import { MAX_ATTACHMENTS_PER_EMAIL } from '@/lib/mailbox/attachments'
import { regenerateDraftContent as regenerateDraftContentPipeline } from '@/lib/pipeline/redesign'
import { MAX_SUBJECT_CHARS, MAX_BODY_CHARS, MAX_INSTRUCTION_CHARS } from '@/lib/validation/email-limits'

const approveSchema = z.object({ emailId: z.string().uuid() })

export async function approveDraft(formData: FormData): Promise<void> {
  const { appUser } = await requireUser()
  const { emailId } = approveSchema.parse({ emailId: formData.get('emailId') })

  // RLS-scoped read: a client-role session can only resolve an email its own
  // policies expose, so a cross-tenant emailId already resolves to null here.
  // The explicit canManageClient check re-confirms it before any write — same
  // defense-in-depth pattern as sendManualEmail (cases/[id]/send-actions.ts).
  // Approving is open to the owning client as well as operators: the client
  // reviewing (and, via updateDraftContent, possibly editing) their own draft
  // is exactly who is meant to approve it.
  const scoped = await createServerClient()
  const email = await getEmailById(scoped, emailId)
  if (!email || email.status !== 'draft' || email.direction !== 'outbound') {
    throw new AppError('VALIDATION_ERROR', 'Email is not an approvable draft', { emailId })
  }
  if (!canManageClient(appUser, email.client_id)) {
    throw new AppError('UNAUTHORIZED', 'Draft belongs to another client', { emailId, userId: appUser.id })
  }
  if (!email.case_id || !email.lead_id || !email.subject || !email.body) {
    throw new AppError('VALIDATION_ERROR', 'Draft is missing required fields', { emailId })
  }

  // Admin client (bypasses RLS) for downstream reads and every write below,
  // matching every other send path. The canManageClient check above is the
  // authorization boundary.
  const supabase = createAdminClient()

  const lead = await getLeadById(supabase, email.lead_id)
  if (!lead?.email) throw new AppError('VALIDATION_ERROR', 'Lead has no email', { emailId })

  const campaign = await getCampaignForCase(supabase, email.case_id)
  if (!campaign) throw new AppError('NOT_FOUND', 'Campaign not found for case', { emailId })

  // Read the set from the database rather than from any form state: the AI's
  // picks and the operator's edits both live there, and it is what an audit of
  // this email will show.
  //
  // Resolved BEFORE the claim on purpose. loadResourceAttachments throws when a
  // resource was deleted after being attached, and the claim is the point of no
  // return — after it, the only way to report the problem is markEmailFailed,
  // which destroys a draft the operator could otherwise have fixed by editing
  // the attachments.
  const recorded = await listAttachmentsForEmail(supabase, email.id)
  const attachments = await loadResourceAttachments(
    supabase, email.client_id, recorded.map((attachment) => attachment.resourceId),
  )

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
      attachments,
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
    // A RATE_LIMITED failure (daily cap / mailreach gate / no healthy
    // mailbox) is a mailbox-availability condition, not a permanent one —
    // without this, the case's wait_reason is left exactly as it was and
    // nothing ever revisits it: write-fanout's 5-minute sweep only picks up
    // a case already flagged with one of AUTO_RETRY_WAIT_REASONS. Mirrors
    // runWriteForCase's own RATE_LIMITED recheck (write.ts) — the send
    // itself already raced the up-front eligibility probe once, so recheck
    // now for an accurate, auto-retryable reason instead of assuming. See
    // .claude/roadmap.md 2026-08-19.
    if (isAppError(error) && error.code === 'RATE_LIMITED') {
      try {
        const client = await getClientById(supabase, email.client_id)
        const eligibility = await getOutreachEligibility(supabase, {
          mailboxIds: campaign.mailbox_ids,
          clientMailreachEnabled: client?.mailreach_enabled ?? false,
          now: new Date(),
        })
        await updateCaseWaiting(supabase, email.case_id, eligibility.eligible ? 'daily_cap' : eligibility.reason)
      } catch (waitError) {
        await logEventSafe({
          clientId: email.client_id,
          caseId: email.case_id,
          actor: 'inbox_approve_draft',
          type: 'inbox.mark_waiting_failed',
          payload: { emailId: email.id, cause: waitError instanceof Error ? waitError.message : String(waitError) },
        })
      }
    }
    revalidatePath('/inbox')
    throw error
  }

  // Mirror the automated write path: approving the first touch starts the
  // 3/7/14-day cadence, and — for a case that was sitting on
  // 'waiting'/'awaiting_manual_approval' (see
  // docs/superpowers/specs/2026-08-17-outreach-send-waiting-system-design.md)
  // — is also the event that actually contacts the lead, closing the gap
  // where the case (and its CRM sync) previously claimed 'contacted' the
  // moment a draft was written, before any human approved it.
  if (email.sequence_step === FIRST_TOUCH_STEP) {
    try {
      await scheduleFirstFollowup(supabase, {
        clientId: email.client_id,
        caseId: email.case_id,
        leadId: email.lead_id,
      })
      // Atomic conditional update, not read-then-write: two concurrent
      // approvals for different leads on the same case (each reaching this
      // point via its own claimDraftForSend) must not both pass a stale
      // status read and double-fire the CRM sync. Only the approval whose
      // update actually flips the case to 'contacted' gets true here.
      const advancedToContacted = await claimCaseContacted(supabase, email.case_id)
      if (advancedToContacted) {
        await enqueueCrmSync(email.case_id, 'contacted')
      }
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
  // The operator's picks. Shape only — resolveSelectedResources is what proves
  // they exist, belong to this client, and fit the per-email budget.
  resourceIds: z.array(z.string().uuid()).max(MAX_ATTACHMENTS_PER_EMAIL).default([]),
})

const updateAttachmentsSchema = z.object({
  emailId: z.string().uuid(),
  resourceIds: z.array(z.string().uuid()).max(MAX_ATTACHMENTS_PER_EMAIL).default([]),
})

// Lets an operator correct what the agent chose before approving. Only ever
// touches a draft — once queued or sent, the set is history.
export async function updateDraftAttachments(formData: FormData): Promise<void> {
  const { appUser } = await requireUser()
  const { emailId, resourceIds } = updateAttachmentsSchema.parse({
    emailId: formData.get('emailId'),
    resourceIds: formData.getAll('resourceIds'),
  })

  // RLS-scoped read + explicit ownership check — see approveDraft. Open to
  // the owning client as well as operators.
  const scoped = await createServerClient()
  const email = await getEmailById(scoped, emailId)
  if (!email || email.status !== 'draft' || email.direction !== 'outbound') {
    throw new AppError('VALIDATION_ERROR', 'Email is not an editable draft', { emailId })
  }
  if (!canManageClient(appUser, email.client_id)) {
    throw new AppError('UNAUTHORIZED', 'Draft belongs to another client', { emailId, userId: appUser.id })
  }

  const supabase = createAdminClient()

  // Validated against the email's own client before anything is written. An
  // unresolvable or over-budget pick must fail here, where the operator or
  // client is looking at the form, rather than at approve time where the
  // only outcome left is a failed send.
  await resolveSelectedResources(supabase, email.client_id, resourceIds)

  await replaceEmailAttachments(supabase, {
    clientId: email.client_id, emailId: email.id, resourceIds,
  })
  revalidatePath('/inbox')
}

const updateContentSchema = z.object({
  emailId: z.string().uuid(),
  subject: z.string().trim().min(1).max(MAX_SUBJECT_CHARS),
  body: z.string().trim().min(1).max(MAX_BODY_CHARS),
})

// Persists a hand-edited (or just-redesigned) subject/body onto a draft. Open
// to the owning client as well as operators — see approveDraft.
export async function updateDraftContent(formData: FormData): Promise<void> {
  const { appUser } = await requireUser()
  const { emailId, subject, body } = updateContentSchema.parse({
    emailId: formData.get('emailId'),
    subject: formData.get('subject'),
    body: formData.get('body'),
  })

  // RLS-scoped read + explicit ownership check — see approveDraft.
  const scoped = await createServerClient()
  const email = await getEmailById(scoped, emailId)
  if (!email) {
    throw new AppError('VALIDATION_ERROR', 'Draft was already sent', { emailId })
  }
  if (!canManageClient(appUser, email.client_id)) {
    throw new AppError('UNAUTHORIZED', 'Draft belongs to another client', { emailId, userId: appUser.id })
  }

  const supabase = createAdminClient()
  const updated = await updateDraftContentRow(supabase, emailId, { subject, body })
  if (!updated) {
    throw new AppError('VALIDATION_ERROR', 'Draft was already sent', { emailId })
  }
  revalidatePath('/inbox')
}

const regenerateSchema = z.object({
  emailId: z.string().uuid(),
  instruction: z.string().trim().min(1).max(MAX_INSTRUCTION_CHARS),
})

export type RegenerateDraftResult =
  | { ok: true; subject: string; body: string }
  | { ok: false; code: 'VALIDATION_ERROR' | 'EXTERNAL_ERROR' | 'EXTERNAL_TIMEOUT' }

// A redesign failure (LLM error/timeout, or the draft having just been
// approved out from under the operator or client) is an expected, user-facing
// outcome that gets retried — not a crash — so it is returned, not thrown.
export async function regenerateDraftContent(formData: FormData): Promise<RegenerateDraftResult> {
  const { appUser } = await requireUser()
  const { emailId, instruction } = regenerateSchema.parse({
    emailId: formData.get('emailId'),
    instruction: formData.get('instruction'),
  })

  // RLS-scoped read + explicit ownership check — see approveDraft. A
  // cross-tenant or nonexistent draft is folded into the same expected
  // VALIDATION_ERROR outcome the pipeline itself returns for a missing draft.
  const scoped = await createServerClient()
  const scopedEmail = await getEmailById(scoped, emailId)
  if (!scopedEmail) {
    return { ok: false, code: 'VALIDATION_ERROR' }
  }
  if (!canManageClient(appUser, scopedEmail.client_id)) {
    throw new AppError('UNAUTHORIZED', 'Draft belongs to another client', { emailId, userId: appUser.id })
  }

  const supabase = createAdminClient()
  let draft: { subject: string; body: string }
  try {
    draft = await regenerateDraftContentPipeline(supabase, { emailId, instruction })
  } catch (error) {
    if (
      error instanceof AppError
      && (error.code === 'EXTERNAL_ERROR' || error.code === 'EXTERNAL_TIMEOUT' || error.code === 'VALIDATION_ERROR')
    ) {
      return { ok: false, code: error.code }
    }
    throw error
  }

  const updated = await updateDraftContentRow(supabase, emailId, draft)
  if (!updated) {
    return { ok: false, code: 'VALIDATION_ERROR' }
  }
  revalidatePath('/inbox')
  return { ok: true, subject: draft.subject, body: draft.body }
}

// Operator supplies the previously-missing fact. We atomically claim the open
// request (open -> answered), store the fact as case_knowledge (kind 'answer',
// human-authored), then let the AI write + send the reply grounded on it.
export async function answerKnowledgeRequest(formData: FormData): Promise<void> {
  const { appUser } = await requireUser()
  if (appUser.role !== 'operator') {
    throw new AppError('UNAUTHORIZED', 'Only operators can answer knowledge requests', { userId: appUser.id })
  }
  const { knowledgeRequestId, answer, resourceIds } = answerSchema.parse({
    knowledgeRequestId: formData.get('knowledgeRequestId'),
    answer: formData.get('answer'),
    resourceIds: formData.getAll('resourceIds'),
  })

  const supabase = createAdminClient()

  // Resolved before the claim so a bad selection mutates nothing: claiming is
  // what flips the request open -> answered, and a rejected form has to leave it
  // open for a corrected resubmit. A request that no longer exists needs no
  // validation — the claim below handles it.
  const pending = await getKnowledgeRequestById(supabase, knowledgeRequestId)
  if (pending) {
    await resolveSelectedResources(supabase, pending.client_id, resourceIds)
  }

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

  // An optional knowledge file does NOT arrive here. Server Actions cap request
  // bodies at 1MB by default, which almost every real PDF exceeds, so the file
  // is uploaded separately to /api/clients/[clientId]/knowledge/file — a Route
  // Handler under no such cap — before this action is invoked. See
  // knowledge-request-row.tsx.
  await runKnowledgeAnswer(supabase, { knowledgeRequestId: kr.id, resourceIds })
  revalidatePath('/inbox')
}
