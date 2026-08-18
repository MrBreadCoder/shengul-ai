'use server'

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { requireUser } from '@/lib/auth/require-user'
import type { AppUser } from '@/lib/db/app-users'
import { createServerClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getCaseById, claimCaseContactedFrom, type CaseRow, type CaseStatus } from '@/lib/db/cases'
import { getLeadById } from '@/lib/db/leads'
import { getCampaignForCase, type CampaignRow } from '@/lib/db/campaigns'
import { enqueueCrmSync } from '@/lib/crm/sync'
import {
  listThreadEmails,
  hasInboundReply,
  claimOutboundEmail,
  insertManualEmail,
  markEmailSent,
  markEmailFailed,
  type EmailRow,
} from '@/lib/db/emails'
import { insertEmailAttachments } from '@/lib/db/email-attachments'
import { requestFollowupSkip } from '@/lib/db/sequences'
import { resolveSelectedResources } from '@/lib/resources/select'
import { loadResourceAttachments } from '@/lib/resources/load-attachments'
import { sendViaMailbox, type SendPurpose, type SendViaMailboxResult } from '@/lib/mailbox/sender'
import { FIRST_TOUCH_STEP, scheduleFirstFollowup } from '@/lib/pipeline/followup'
import { canManageClient } from '@/lib/auth/can-manage-client'
import { MAX_ATTACHMENTS_PER_EMAIL } from '@/lib/mailbox/attachments'
import { AppError, isAppError, type AppErrorCode } from '@/lib/errors/app-error'
import { logEventSafe } from '@/lib/events/log-event'
import { MAX_SUBJECT_CHARS, MAX_BODY_CHARS } from '@/lib/validation/email-limits'

// Statuses a manual first touch advances to 'contacted'. A case already past
// this point keeps whatever the pipeline gave it — a manual email is not a
// reason to walk an in-conversation/won/lost/etc. case backwards. 'writing'
// included: it means the automated write pipeline has this case claimed and
// may be mid-send — a human's manual first touch is just as much "this case
// has now been contacted" as the automated one would have produced.
// 'waiting' (added alongside the outreach waiting system) covers a case
// blocked on the mailbox gate/cap/health, or on a human's own draft approval
// — a manual send from here is exactly the rescue path for the first three.
// Passed straight to claimCaseContactedFrom's atomic `.in('status', ...)`
// claim — not read as an in-memory pre-check — so a case that advanced past
// this list between the earlier `getCaseById` read and this point (another
// lead's reply/approval on the same case) is re-verified against its live
// DB status, not a stale snapshot.
const PRE_CONTACT_STATUSES: readonly CaseStatus[] = ['new', 'researching', 'ready', 'writing', 'waiting']

const sendSchema = z.object({
  caseId: z.string().uuid(),
  leadId: z.string().uuid(),
  subject: z.string().trim().min(1).max(MAX_SUBJECT_CHARS),
  body: z.string().trim().min(1).max(MAX_BODY_CHARS),
  // Shape only — resolveSelectedResources proves they exist, belong to this
  // client and fit the per-email budget.
  resourceIds: z.array(z.string().uuid()).max(MAX_ATTACHMENTS_PER_EMAIL).default([]),
})

export type SendManualEmailResult = { ok: true } | { ok: false; code: AppErrorCode }

/**
 * Sends an email a human wrote, to a lead on one of their own cases.
 *
 * Unlike approveDraft this is open to client-role users: that guard exists
 * because approving means rubber-stamping AI copy, while here the human wrote
 * the words. The authorization boundary is the RLS-scoped read below —
 * a client-role session can only resolve cases and leads its own policies
 * expose, re-checked against the session afterwards. The writes then go through
 * the admin client because RLS makes client-role users read-only on `emails`
 * (migration 0002).
 *
 * Returns a result rather than throwing for expected `AppError` failures:
 * Next.js Server Actions strip custom properties (like `.code`) from a thrown
 * error before it reaches the client, so the caller could never branch on it.
 * A genuinely unexpected error still throws, for the nearest error boundary.
 */
export async function sendManualEmail(formData: FormData): Promise<SendManualEmailResult> {
  try {
    await sendManualEmailUnsafe(formData)
    return { ok: true }
  } catch (error) {
    if (isAppError(error)) return { ok: false, code: error.code }
    throw error
  }
}

async function sendManualEmailUnsafe(formData: FormData): Promise<void> {
  const { appUser } = await requireUser()
  const { caseId, leadId, subject, body, resourceIds } = sendSchema.parse({
    caseId: formData.get('caseId'),
    leadId: formData.get('leadId'),
    subject: formData.get('subject'),
    body: formData.get('body'),
    resourceIds: formData.getAll('resourceIds'),
  })

  const scoped = await createServerClient()
  const { kase, leadEmail } = await loadAuthorizedSendTargets(scoped, { appUser, caseId, leadId })

  const supabase = createAdminClient()
  const campaign = await loadSendableCampaign(supabase, caseId)

  // Resolved BEFORE anything is claimed or written, matching approveDraft: a
  // selection the client can still correct must fail while the form is on
  // screen, not after the point of no return where the only outcome left is a
  // failed email.
  await resolveSelectedResources(supabase, kase.client_id, resourceIds)

  const claimed = await claimOrRecordManualEmail(supabase, {
    kase, caseId, leadId, subject, body, resourceIds, sentBy: appUser.id,
  })

  const sent = await sendClaimedEmail(supabase, {
    kase,
    caseId,
    resourceIds,
    mailboxIds: campaign.mailbox_ids,
    to: leadEmail,
    subject,
    body,
    threadId: claimed.threadId,
    inReplyTo: claimed.inReplyTo,
    purpose: claimed.purpose,
    email: claimed.email,
  })

  await finalizeManualSend(supabase, {
    kase, caseId, leadId, appUser, sent,
    email: claimed.email,
    isFirstTouch: claimed.isFirstTouch,
    resourceCount: resourceIds.length,
  })
}

// RLS-scoped: a client-role session can only resolve a case/lead its own
// policies expose. Throws VALIDATION_ERROR/UNAUTHORIZED/NOT_FOUND for every
// way the submitted (caseId, leadId) pair can fail to be a sendable target.
async function loadAuthorizedSendTargets(
  scoped: SupabaseClient<Database>,
  input: { appUser: AppUser; caseId: string; leadId: string },
): Promise<{ kase: CaseRow; leadEmail: string }> {
  const kase = await getCaseById(scoped, input.caseId)
  // RLS makes an out-of-scope case indistinguishable from a missing one, which
  // is what we want: no existence leak across clients.
  if (!kase) throw new AppError('NOT_FOUND', 'Case not found', { caseId: input.caseId })
  if (!canManageClient(input.appUser, kase.client_id)) {
    throw new AppError('UNAUTHORIZED', 'Case belongs to another client', { caseId: input.caseId, userId: input.appUser.id })
  }
  const lead = await getLeadById(scoped, input.leadId)
  if (!lead || lead.case_id !== input.caseId) {
    throw new AppError('VALIDATION_ERROR', 'Contact does not belong to this case', {
      caseId: input.caseId, leadId: input.leadId,
    })
  }
  if (!lead.email) {
    throw new AppError('VALIDATION_ERROR', 'This contact has no email address', { leadId: input.leadId })
  }
  return { kase, leadEmail: lead.email }
}

// Matches runFollowupStep's campaign-active guard: a paused/archived campaign
// freezes all outbound for its leads, manual sends included — a human can
// still write a note, but must not push mail out through a frozen campaign.
async function loadSendableCampaign(
  supabase: SupabaseClient<Database>,
  caseId: string,
): Promise<CampaignRow> {
  const campaign = await getCampaignForCase(supabase, caseId)
  if (!campaign) throw new AppError('NOT_FOUND', 'Campaign not found for case', { caseId })
  if (campaign.status !== 'active') {
    throw new AppError('VALIDATION_ERROR', 'This campaign is not active', { caseId, status: campaign.status })
  }
  if (campaign.mailbox_ids.length === 0) {
    throw new AppError('VALIDATION_ERROR', 'No mailbox is connected to this campaign', { caseId })
  }
  return campaign
}

interface ClaimedManualEmail {
  email: EmailRow
  isFirstTouch: boolean
  threadId: string | null
  inReplyTo: string | null
  purpose: SendPurpose
}

// Claiming step 0 when it is free makes this email the first touch. That is
// what stops the write cron cold-emailing the same person days later, and
// what stops find_stuck_cases (0006) dragging the case back to 'ready'
// precisely because it has no step-0 outbound. A taken slot means a cadence
// already exists, so this is an interjection instead.
async function claimOrRecordManualEmail(
  supabase: SupabaseClient<Database>,
  input: {
    kase: CaseRow
    caseId: string
    leadId: string
    subject: string
    body: string
    resourceIds: string[]
    sentBy: string
  },
): Promise<ClaimedManualEmail> {
  const thread = await listThreadEmails(supabase, input.leadId)
  const firstOutbound = thread.find((email) => email.direction === 'outbound')
  const threadId = firstOutbound?.thread_id ?? null
  const inReplyTo = thread.at(-1)?.provider_message_id ?? null
  // A lead who has written to us can be answered even while suppressed for
  // outreach; sendViaMailbox enforces that distinction, and a hard bounce still
  // blocks both.
  const purpose: SendPurpose = (await hasInboundReply(supabase, input.leadId)) ? 'reply' : 'outreach'

  const claimed = await claimOutboundEmail(supabase, {
    client_id: input.kase.client_id,
    case_id: input.caseId,
    lead_id: input.leadId,
    thread_id: threadId,
    direction: 'outbound',
    subject: input.subject,
    body: input.body,
    status: 'queued',
    sequence_step: FIRST_TOUCH_STEP,
    sent_by: input.sentBy,
  })
  const isFirstTouch = claimed !== null
  const email =
    claimed ??
    (await insertManualEmail(supabase, {
      client_id: input.kase.client_id,
      case_id: input.caseId,
      lead_id: input.leadId,
      thread_id: threadId,
      direction: 'outbound',
      subject: input.subject,
      body: input.body,
      status: 'queued',
      sequence_step: null,
      sent_by: input.sentBy,
    }))

  if (input.resourceIds.length > 0) {
    await insertEmailAttachments(supabase, {
      clientId: input.kase.client_id, emailId: email.id, resourceIds: input.resourceIds,
    })
  }

  return { email, isFirstTouch, threadId, inReplyTo, purpose }
}

async function sendClaimedEmail(
  supabase: SupabaseClient<Database>,
  input: {
    kase: CaseRow
    caseId: string
    resourceIds: string[]
    mailboxIds: string[]
    to: string
    subject: string
    body: string
    threadId: string | null
    inReplyTo: string | null
    purpose: SendPurpose
    email: EmailRow
  },
): Promise<SendViaMailboxResult> {
  try {
    // Inside the try so a storage failure lands in the same markEmailFailed path
    // as a send failure: an email promising an attachment must not go out
    // without one.
    const attachments = await loadResourceAttachments(supabase, input.kase.client_id, input.resourceIds)
    return await sendViaMailbox(supabase, {
      clientId: input.kase.client_id,
      mailboxIds: input.mailboxIds,
      to: input.to,
      subject: input.subject,
      body: input.body,
      purpose: input.purpose,
      threadId: input.threadId,
      inReplyToMessageId: input.inReplyTo,
      references: input.inReplyTo,
      attachments,
      // A human answering a prospect is never blocked by the agent having used
      // the day's quota, nor by the mailbox still being under mailreach
      // warmup — that gate throttles the agent's own automated volume, not a
      // one-off manual email. Health and suppression still apply.
      bypassDailyCap: true,
      bypassMailreachGate: true,
    })
  } catch (error) {
    try {
      await markEmailFailed(supabase, input.email.id)
    } catch {
      // Best-effort status write; the send error below is the one that matters.
    }
    revalidatePath(`/cases/${input.caseId}`)
    throw error
  }
}

interface ManualSendBookkeepingContext {
  kase: CaseRow
  caseId: string
  leadId: string
  appUser: AppUser
  email: EmailRow
}

// Shared by every best-effort step below: none of them may surface to the
// client as a failed send, so each failure is logged and swallowed here.
async function logManualBookkeepingFailure(input: ManualSendBookkeepingContext, error: unknown): Promise<void> {
  await logEventSafe({
    clientId: input.kase.client_id,
    caseId: input.caseId,
    actor: `human:${input.appUser.id}`,
    type: 'email.manual_bookkeeping_failed',
    payload: {
      emailId: input.email.id, leadId: input.leadId, cause: error instanceof Error ? error.message : String(error),
    },
  })
}

// Best-effort past this point: the mail is already out, so a bookkeeping
// failure must not surface to the client as a failed send.
async function finalizeManualSend(
  supabase: SupabaseClient<Database>,
  input: {
    kase: CaseRow
    caseId: string
    leadId: string
    appUser: AppUser
    sent: SendViaMailboxResult
    email: EmailRow
    isFirstTouch: boolean
    resourceCount: number
  },
): Promise<void> {
  await markEmailSent(supabase, input.email.id, {
    providerMessageId: input.sent.providerMessageId,
    threadId: input.sent.threadId,
    mailboxId: input.sent.mailboxId,
  })

  if (input.isFirstTouch) {
    // Advancing the case runs independently of follow-up scheduling below: a
    // case that was genuinely just contacted must not be stuck on
    // 'new'/'writing'/'waiting' just because scheduleFirstFollowup (a
    // separate, best-effort QStash publish) happened to throw.
    //
    // Atomic conditional update, not read-then-write: `input.kase.status` is
    // a snapshot from earlier in the request (loadAuthorizedSendTargets), and
    // this case can advance past first contact in the meantime — a reply or
    // an approval on another lead sharing the same case. Reading that stale
    // status here would let this call "win" a claim the case has already
    // moved past. Only the call whose update actually flips the case to
    // 'contacted' gets true and should fire the CRM sync — same pattern as
    // approveDraft (inbox/actions.ts) and claimCaseContacted.
    try {
      const advancedToContacted = await claimCaseContactedFrom(supabase, input.caseId, PRE_CONTACT_STATUSES)
      if (advancedToContacted) {
        // Mirrors approveDraft (inbox/actions.ts): a manual send is just as
        // much "this case has now been contacted" as an approved draft, and
        // must fire the same CRM sync — including the waiting case this
        // manual send exists to rescue.
        await enqueueCrmSync(input.caseId, 'contacted')
      }
    } catch (error) {
      await logManualBookkeepingFailure(input, error)
    }
    try {
      await scheduleFirstFollowup(supabase, { clientId: input.kase.client_id, caseId: input.caseId, leadId: input.leadId })
    } catch (error) {
      await logManualBookkeepingFailure(input, error)
    }
  } else {
    try {
      await requestFollowupSkip(supabase, input.leadId)
    } catch (error) {
      await logManualBookkeepingFailure(input, error)
    }
  }

  await logEventSafe({
    clientId: input.kase.client_id,
    caseId: input.caseId,
    actor: `human:${input.appUser.id}`,
    type: 'email.manual_sent',
    payload: {
      emailId: input.email.id, leadId: input.leadId, isFirstTouch: input.isFirstTouch, attachmentCount: input.resourceCount,
    },
  })

  revalidatePath(`/cases/${input.caseId}`)
  revalidatePath('/mail')
}
