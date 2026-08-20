import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { AppError } from '@/lib/errors/app-error'
import { listKnowledgeForCase, type KnowledgeRow } from '@/lib/db/case-knowledge'
import { listActiveLeadsForCase, updateLeadStage, type LeadRow } from '@/lib/db/leads'
import { isSuppressed } from '@/lib/db/suppressions'
import { getClientById, type ClientRow } from '@/lib/db/clients'
import { getEmailTemplateById, getDefaultEmailTemplate, type EmailTemplateRow } from '@/lib/db/email-templates'
import { claimOutboundEmail, markEmailSent, markEmailFailed, markEmailWaiting, listWaitingLeadIds } from '@/lib/db/emails'
import { updateCaseWaiting, recomputeCaseStatus, isCrmSyncStatus, type CaseWaitReason } from '@/lib/db/cases'
import { getOutreachEligibility } from '@/lib/mailbox/eligibility'
import { enqueueCrmSync } from '@/lib/crm/sync'
import { sendViaMailbox, type SendViaMailboxResult } from '@/lib/mailbox/sender'
import { generateJson, type LlmCallContext, EMAIL_WRITER_MODEL_ID } from '@/lib/llm/client'
import { FIRST_TOUCH_STEP, scheduleFirstFollowup } from './followup'
import { HUMAN_VOICE_INSTRUCTION } from './email-voice'
import { appendSignatureBlock, resolveSignatureContext } from './signature'
import { logEventSafe } from '@/lib/events/log-event'
import { draftSchema, SUBJECT_TARGET_CHARS } from './draft-schema'

// Exported (not just module-scoped) so scripts/regenerate-sample-emails.ts can
// drive the exact same generation path against a historical row instead of
// duplicating the prompt-construction logic.
// Raised 1,600 -> 2,600 (2026-08-10): unlike reply.ts's classificationSchema,
// draftSchema has no null branch — every call must produce a full subject +
// body, and reasoning tokens (even at 'low') compete against a body that
// can never be skipped. 1,600 was proven unsafe for that always-prose case
// (see .claude/roadmap.md 2026-08-10, recurrence of the 2026-08-08
// "No object generated" truncation bug).
export const MAX_OUTPUT_TOKENS = 2_600
// Headroom kept from the 'medium'-thinking era in case a call runs long;
// cheap to keep even after the 2026-08-10 drop to 'low' thinking.
const GENERATE_TIMEOUT_MS = 90_000
const ACTOR = 'email_writer_agent'

// Re-exported so scripts/regenerate-sample-emails.ts and
// scripts/rewrite-draft-emails.ts (which drive this exact generation path
// against historical/draft rows) default to the same model write.ts
// actually uses, without duplicating the constant. Defined once in
// src/lib/llm/client.ts — every email-writing pipeline stage
// (followup.ts, redesign.ts, reply.ts, knowledge-answer.ts) imports it
// from there directly.
export { EMAIL_WRITER_MODEL_ID }

export type ReplyMode = Database['public']['Enums']['reply_mode']

export interface RunWriteInput {
  clientId: string
  campaignId: string
  caseId: string
  replyMode: ReplyMode
  valueProp: string | null
  bookingLink: string | null
  mailboxIds: string[]
  companyName: string
  // Campaign-level signature overrides — null means inherit the client's
  // value. See resolveSignatureContext in ./signature.
  signatureName: string | null
  signatureTitle: string | null
  signaturePhone: string | null
  signatureAddress: string | null
  // Per-campaign override of the owning client's email template — null
  // means inherit the client's template. See resolveEmailTemplate below.
  campaignEmailTemplateId: string | null
  // The case's status/wait_reason as loaded by the caller (write/route.ts)
  // just before this run — used only to suppress a redundant
  // 'pipeline.write.waiting' log when a retried, still-ineligible case
  // hasn't actually changed state since the last tick.
  currentStatus: Database['public']['Enums']['case_status']
  currentWaitReason: CaseWaitReason | null
}

export interface WriteSummary {
  caseId: string
  drafted: number
  sent: number
}

// Lower number = surfaced first in the dossier text handed to the model. A
// (pain_point) or (news) fact makes a far sharper personalization hook than
// a bare (company) firmographic line (industry/size/founding year/location)
// — putting the sharpest facts first means the model reaches for them before
// it ever gets to the generic ones, regardless of how well it follows the
// prioritization instruction in FORMAL_INTRO_SYSTEM_PROMPT's hook beat.
const DOSSIER_KIND_PRIORITY: Record<Database['public']['Enums']['knowledge_kind'], number> = {
  pain_point: 0,
  news: 1,
  answer: 2,
  person: 3,
  company: 4,
}

// Shared across every template's system prompt so subject-line formatting
// can never drift between them.
const SUBJECT_LINE_RULES = [
  `Subject line: 2-5 words, under ${SUBJECT_TARGET_CHARS} characters so it never truncates`,
  'on mobile. Make it specific to the recipient\'s company, role, or a dossier fact —',
  'never generic filler like "Quick question" or "Following up". No ALL CAPS, no',
  'exclamation marks, no "Re:"/"Fwd:" prefixes, no spam-trigger words (free, guarantee,',
  'act now, urgent, limited time, buy now).',
]

// Always true regardless of which email_templates row a campaign or client
// is on — never something an operator-authored template's text can opt out
// of. This is the entire trust boundary between "operator picks the
// template" and "operator can break compliance": subject formatting,
// English-only output, no bulk-sender markers, and dossier-grounded facts
// all live here, in code, never in a database row a non-engineer edits. See
// docs/superpowers/specs/2026-08-09-editable-email-styles-design.md (the
// mechanism it describes is unchanged; only the "style" naming and the
// per-row content model — literal template vs. abstract voice instructions
// — changed 2026-08-15, see .claude/roadmap.md).
const FIXED_GUARDRAILS = [
  'Always write in English, even if the dossier or company knowledge below is in',
  'another language — translate any facts you use, never copy foreign-language text.',
  'No bulk markers, no unsubscribe footer, no tracking language.',
  'Use only facts present in the provided dossier or company knowledge below. Never invent a name,',
  'a year, a location, or any other specific you were not given.',
  // Added 2026-08-11 after a report on Uniforms Fashion's hospital leads found
  // the model picking a reputational (news) fact — a trustee election — over a
  // sharper operational one that was ranked ahead of it by
  // DOSSIER_KIND_PRIORITY. Kind alone doesn't capture sales relevance; this
  // rule applies to every client on every style, not just this one, since any
  // dossier can mix reputational and operational facts within the same kind.
  'When multiple dossier facts share the same kind, prefer the one implying a concrete',
  'operational change — expansion, new facility, funding round, contract win, leadership',
  'change tied to strategy, hiring surge, compliance or inspection event — over one that is',
  'merely reputational, like an award, a conference appearance, a board seat, or a media',
  'profile. The former gives a real reason to reach out now; the latter does not.',
  // Added 2026-08-11, same report: the strongest fact for one lead was a
  // hospital's 2020 near-closure and financial instability, and the model
  // silently dropped it for a weaker fact rather than cite it — a reasonable
  // instinct with no instruction to act on safely. Global because any
  // client's dossier can surface a fact that's unflattering to the recipient.
  'If the strongest available dossier fact is negative about the recipient\'s organization —',
  'financial distress, layoffs, low ratings, understaffing, a lawsuit, a data breach, a',
  'closure — never restate the negative fact directly; naming it back to the recipient reads',
  'as an insult, not research. Reference the neutral operational condition it implies instead,',
  'without naming the negative event itself, or fall back to the next-strongest fact if no',
  'tactful phrasing exists.',
  // Merged in from a survey of public cold-email system prompts (Utopian Labs'
  // cold-email-1, the "Sales Cold Email Coach" GPT, Artisan/Ava's hallucination-
  // suppression framing, cupel-cloud's Claude-SDR copy frameworks) — the three
  // rules every one of them enforces that FIXED_GUARDRAILS didn't yet: a body
  // length target, exactly one CTA, and problem-first framing over a pitch.
  // Everything else those prompts do (dossier-only facts, no invented specifics,
  // no hype/jargon, personalize per-recipient) we already cover above and in
  // HUMAN_VOICE_INSTRUCTION, so only the net-new rules were added.
  'Lead with the sharpest problem or insight from the dossier, not a pitch for what we do.',
  'The value proposition backs up the problem; it never opens the email.',
  'Use exactly one call to action, phrased so it can be answered yes or no in one line. Never stack multiple asks.',
  'Keep the body to one short paragraph, target around 90 words. Say less, not more.',
  ...SUBJECT_LINE_RULES,
  HUMAN_VOICE_INSTRUCTION,
].join(' ')

// Frames a campaign's reference template (email_templates.template_text) so
// the model treats it as inspiration to personalize, not a literal
// find-and-replace target or a second, conflicting set of rules. Written to
// work whether the row holds an actual example email (the normal case for a
// new per-campaign template — see .claude/roadmap.md 2026-08-15) or the
// older abstract "1. Greeting: ... 2. Self-introduction: ..."-style
// instructions the two seeded rows (Concise / Formal introduction) still
// carry — "study and personalize" reads sensibly against either.
const TEMPLATE_USAGE_INSTRUCTION = [
  "Below is this campaign's reference template — the client's own voice, structure, and offer for this audience.",
  'Study its opening, structure, tone, and the value-proposition points it draws on, then write a new, fully',
  'personalized email in the same spirit for this specific recipient. Never copy it verbatim and never leave a',
  'bracketed placeholder like [Name] or [Hotel Name] in the output — replace it with the real recipient or company',
  'detail given below, or drop that clause entirely if no matching detail is available. If the template contains',
  'more than one example separated by a "---" line, they cover different sub-segments of this campaign\'s',
  'audience — use whichever one\'s framing and proof points best match this recipient\'s actual company or',
  'industry from the dossier below, and do not blend proof points from the others. The template\'s own sign-off is',
  'never part of your output — a signature block is appended separately, after you write the body.',
  // Ported from the "Formal introduction" style's own hand-tuned fix
  // (2026-08-11 production bug: the model bolted a bare "Company X has done
  // Y since Z" sentence onto an otherwise-personalized email) — moved here,
  // to the shared wrapper, so every template gets it rather than only the
  // one style whose author happened to write it in. Restated for the
  // template case specifically: a literal reference email is exactly the
  // shape that invites tacking a stray researched sentence onto the end
  // instead of rewriting a clause of the template itself.
  'Never isolate the dossier personalization into its own flat, bolted-on sentence — that reads like a database',
  'record stapled to a form letter, not a personal email. Instead, rewrite the specific clause of the template',
  'that the fact naturally belongs to (the hook, a capability line, or the ask) so the fact is load-bearing in that',
  'sentence, not appended after it. If the template has more than one capability or proof point, prefer folding the',
  'personalization into whichever one it most directly supports, rather than adding a new sentence anywhere.',
  // Added same day as the rule above, after testing it: rewriting a
  // template clause to carry a fact makes it easy to over-smooth the fact
  // into a vaguer restatement that fits the sentence better than it fits
  // the recipient. Weaving must not cost specificity.
  'When you rewrite a clause to carry a dossier fact, keep the fact\'s concrete specifics intact — named events,',
  'programs, dates, and figures — rather than generalizing it into a softer statement that could describe any',
  'company in the recipient\'s industry. The rewritten sentence must be true of this recipient specifically, not',
  'merely plausible for their category.',
  'Reference template:',
].join(' ')

// Combines the fixed guardrails above with a campaign or client's
// operator-authored reference template (email_templates.template_text). The
// only place template text touches the system prompt — kept pure so it's
// trivial to unit test.
export function buildSystemPrompt(templateText: string): string {
  return `${FIXED_GUARDRAILS} ${TEMPLATE_USAGE_INSTRUCTION}\n"""\n${templateText}\n"""`
}

// Campaign template (if set) beats the owning client's template, which beats
// whichever template is marked default — same precedence order as
// resolveSignatureContext in ./signature, just against a single id instead
// of four independent fields. Exported so scripts/regenerate-sample-emails.ts
// and scripts/rewrite-draft-emails.ts (which drive this exact generation
// path against historical/draft rows) resolve the same template write.ts
// actually uses, without duplicating this precedence logic.
export async function resolveEmailTemplate(
  supabase: SupabaseClient<Database>,
  campaignEmailTemplateId: string | null,
  client: ClientRow | null,
): Promise<EmailTemplateRow> {
  const campaignTemplate = campaignEmailTemplateId
    ? await getEmailTemplateById(supabase, campaignEmailTemplateId)
    : null
  if (campaignTemplate) return campaignTemplate

  const clientTemplate = client?.email_template_id ? await getEmailTemplateById(supabase, client.email_template_id) : null
  return clientTemplate ?? (await getDefaultEmailTemplate(supabase))
}

export function buildPrompt(
  input: RunWriteInput,
  lead: LeadRow,
  knowledge: KnowledgeRow[],
  client: ClientRow | null,
): string {
  const sortedKnowledge = [...knowledge].sort((a, b) => DOSSIER_KIND_PRIORITY[a.kind] - DOSSIER_KIND_PRIORITY[b.kind])
  const dossier = sortedKnowledge.map((k) => `- (${k.kind}) ${k.content}`).join('\n') || '(no dossier facts)'
  return [
    `Recipient: ${lead.full_name}${lead.title ? `, ${lead.title}` : ''} at ${input.companyName}`,
    `Our value proposition: ${input.valueProp ?? 'n/a'}`,
    client?.name ? `Our company name: ${client.name}` : '',
    client?.signature_name ? `Sender name: ${client.signature_name}` : '',
    client?.company_info ? `About our company:\n${client.company_info}` : '',
    input.bookingLink ? `Booking link (optional CTA): ${input.bookingLink}` : '',
    `Dossier:\n${dossier}`,
    'Write the first-touch email. Return a subject and a body.',
  ]
    .filter(Boolean)
    .join('\n\n')
}

// auto_send and hybrid both send first-touch immediately (hybrid only diverges
// on replies, per .claude/architecture.md §6 Stage 4). human_approve leaves a draft.
function shouldSendFirstTouch(replyMode: ReplyMode): boolean {
  return replyMode === 'auto_send' || replyMode === 'hybrid'
}

// Persists 'waiting' with one retry. 'queued' (where claimOutboundEmail left
// the row) is a dead end for a retried write pass on this same lead — its
// upsert no-ops against the still-occupied slot, and its own fallback
// (reclaimFailedOutboundEmail) only reclaims 'failed' — so a swallowed
// failure here would leave the retry silently skipping forever, and the
// drain sweep (resend-failed.ts) would never see it either, since it only
// polls 'waiting'. A persistent failure falls back to 'failed' (still
// reclaimable by claimOutboundEmail's own fallback) and rethrows rather than
// silently resolving — the caller must not report this lead as routinely
// parked 'waiting' when the row is actually 'failed', or the case-level
// wait_reason bookkeeping built on that outcome desyncs from the real row.
async function parkAsWaiting(supabase: SupabaseClient<Database>, id: string): Promise<void> {
  try {
    await markEmailWaiting(supabase, id)
  } catch {
    try {
      await markEmailWaiting(supabase, id)
    } catch (error) {
      await markEmailFailed(supabase, id)
      throw error
    }
  }
}

async function processLead(
  supabase: SupabaseClient<Database>,
  input: RunWriteInput,
  lead: LeadRow,
  knowledge: KnowledgeRow[],
  client: ClientRow | null,
): Promise<'sent' | 'drafted' | 'skipped' | 'waiting'> {
  if (!lead.email) return 'skipped'
  if (await isSuppressed(supabase, input.clientId, lead.email)) return 'skipped'

  // Resolves this campaign's configured template, falling back to the
  // client's, falling back to the DB-wide default whenever neither is set
  // (or the client has no row at all) — same "missing client row never
  // blocks generation" guarantee the old selectSystemPrompt(undefined)
  // fallback provided.
  const template = await resolveEmailTemplate(supabase, input.campaignEmailTemplateId, client)

  const context: LlmCallContext = { clientId: input.clientId, caseId: input.caseId, actor: ACTOR }
  const draft = await generateJson(context, {
    instructions: buildSystemPrompt(template.template_text),
    prompt: buildPrompt(input, lead, knowledge, client),
    schema: draftSchema,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    timeoutMs: GENERATE_TIMEOUT_MS,
    modelId: EMAIL_WRITER_MODEL_ID,
    // Raised back 'low' -> 'medium' (2026-08-12): the 2026-08-10 cost/latency
    // cut regressed email quality — FIXED_GUARDRAILS + a campaign's
    // reference template is a long, dense rulebook (isolated-fact avoidance,
    // no-overclaim, relevance, tone), and 'low' thinking wasn't reliably
    // holding all of it under real dossiers (see .claude/roadmap.md
    // 2026-08-12). MAX_OUTPUT_TOKENS keeps its 2,600 headroom regardless:
    // draftSchema has no null branch, so every call still owes a full
    // subject + body even at 'low' (see the 2026-08-08 "No object
    // generated" truncation bug) — that headroom reasoning is unaffected by
    // the thinking-level choice.
    thinkingLevel: 'medium',
  })

  // Deterministic — never left to the model's discretion. Appended here,
  // before the claim, so both a sent email and a human_approve draft carry it.
  const signedBody = appendSignatureBlock(
    draft.body,
    resolveSignatureContext(client, {
      signatureName: input.signatureName,
      signatureTitle: input.signatureTitle,
      phone: input.signaturePhone,
      address: input.signatureAddress,
    }),
  )

  // Claim the (lead, step 0, outbound) slot BEFORE sending — a retry that finds
  // the slot taken returns null and we never double-send.
  const claimed = await claimOutboundEmail(supabase, {
    client_id: input.clientId,
    case_id: input.caseId,
    lead_id: lead.id,
    direction: 'outbound',
    subject: draft.subject,
    body: signedBody,
    status: shouldSendFirstTouch(input.replyMode) ? 'queued' : 'draft',
    sequence_step: FIRST_TOUCH_STEP,
  })
  if (!claimed) return 'skipped'

  if (!shouldSendFirstTouch(input.replyMode)) {
    await updateLeadStage(supabase, lead.id, { stage: 'waiting', waitReason: 'awaiting_manual_approval' })
    return 'drafted'
  }

  let sent: SendViaMailboxResult
  try {
    sent = await sendViaMailbox(supabase, {
      clientId: input.clientId,
      mailboxIds: input.mailboxIds,
      to: lead.email,
      subject: draft.subject,
      body: signedBody,
      purpose: 'outreach',
    })
  } catch (error) {
    // A RATE_LIMITED failure means content already exists on this row but
    // couldn't send this instant — park it as-is for the drain sweep
    // (lib/pipeline/resend-failed.ts), never regenerate. Any other error
    // means the send is genuinely broken.
    if (error instanceof AppError && error.code === 'RATE_LIMITED') {
      await parkAsWaiting(supabase, claimed.id)
      await updateLeadStage(supabase, lead.id, { stage: 'waiting', waitReason: 'awaiting_resend' })
      return 'waiting'
    }
    await markEmailFailed(supabase, claimed.id)
    throw error
  }

  await markEmailSent(supabase, claimed.id, {
    providerMessageId: sent.providerMessageId,
    threadId: sent.threadId,
    mailboxId: sent.mailboxId,
  })
  // Stage update runs before follow-up scheduling, and scheduling is
  // isolated as best-effort: a claimOutboundEmail retry after this email is
  // 'sent' finds the (lead, step 0, outbound) slot already taken and
  // returns null (see the guard above), so a retried processLead call would
  // never reach updateLeadStage again — the contacted stage must be
  // persisted unconditionally, right after the send that earns it.
  // scheduleFirstFollowup is idempotent (createSequence no-ops if a
  // sequence already exists), so a failure here is logged rather than
  // thrown — it must not abort the rest of this case's leads loop.
  await updateLeadStage(supabase, lead.id, { stage: 'contacted' })
  try {
    await scheduleFirstFollowup(supabase, {
      clientId: input.clientId,
      caseId: input.caseId,
      leadId: lead.id,
    })
  } catch (error) {
    await logEventSafe({
      clientId: input.clientId,
      caseId: input.caseId,
      actor: ACTOR,
      type: 'pipeline.write.schedule_followup_failed',
      payload: { leadId: lead.id, cause: error instanceof Error ? error.message : String(error) },
    })
  }
  return 'sent'
}

export async function runWriteForCase(
  supabase: SupabaseClient<Database>,
  input: RunWriteInput,
): Promise<WriteSummary> {
  const client = await getClientById(supabase, input.clientId)

  const eligibility = await getOutreachEligibility(supabase, {
    mailboxIds: input.mailboxIds,
    clientMailreachEnabled: client?.mailreach_enabled ?? false,
    now: new Date(),
  })
  if (!eligibility.eligible) {
    const changed = input.currentStatus !== 'waiting' || input.currentWaitReason !== eligibility.reason
    await updateCaseWaiting(supabase, input.caseId, eligibility.reason)
    // Logged only on an actual transition — a still-gated case re-checked
    // every 5 minutes for hours must not spam the event log each tick.
    if (changed) {
      await logEventSafe({
        clientId: input.clientId,
        caseId: input.caseId,
        actor: ACTOR,
        type: 'pipeline.write.waiting',
        payload: {
          reason: eligibility.reason,
          retryAfter: 'retryAfter' in eligibility ? eligibility.retryAfter.toISOString() : null,
        },
      })
    }
    return { caseId: input.caseId, drafted: 0, sent: 0 }
  }

  const knowledge = await listKnowledgeForCase(supabase, input.caseId)
  const leads = await listActiveLeadsForCase(supabase, input.caseId)
  const waitingLeadIds = await listWaitingLeadIds(supabase, input.caseId)

  let sent = 0
  let drafted = 0
  let waiting = 0
  for (const lead of leads) {
    // Content already exists and is parked for the drain sweep — skip the
    // LLM call entirely rather than generating a draft whose claim will
    // just no-op against the row the sweep owns.
    if (waitingLeadIds.has(lead.id)) {
      waiting += 1
      continue
    }
    // `k.lead_id ?? null` (not a bare `=== null` check) treats a row that
    // omits the field entirely the same as one that explicitly has it null —
    // both existing test fixtures and any case_knowledge row inserted before
    // this migration lack the key outright, and both mean "company-wide
    // fact," never "silently excluded."
    const leadKnowledge = knowledge.filter((k) => (k.lead_id ?? null) === null || k.lead_id === lead.id)
    const outcome = await processLead(supabase, input, lead, leadKnowledge, client)
    if (outcome === 'sent') sent += 1
    if (outcome === 'drafted') drafted += 1
    if (outcome === 'waiting') waiting += 1
  }

  if (sent > 0 || drafted > 0 || waiting > 0) {
    // Every real per-lead outcome above already wrote its own lead's
    // stage — this is the one recompute for the whole run, not one per
    // lead, so a concurrent event on a different lead of this case can't
    // read a partially-updated case mid-loop and prematurely overwrite the
    // claimCaseForWriting dispatch lock this run is still holding.
    const recompute = await recomputeCaseStatus(supabase, input.caseId)
    if (recompute.didChange && isCrmSyncStatus(recompute.status)) {
      await enqueueCrmSync(input.caseId, recompute.status)
    }
  } else {
    // Every active lead was permanently disqualified this attempt (missing
    // email, suppressed) — processLead checks suppression before
    // generation, so this path never paid for an LLM call either. This is
    // a case-level condition ("no viable leads exist"), not any one lead's
    // stage — stays a direct write. Not 'contacted' (never sent), and not
    // left at 'writing' (would misread as stuck and get endlessly
    // re-queued by stuck-sweep for a condition that won't change on its
    // own). 'no_viable_leads' is deliberately excluded from the auto-retry
    // set — nothing about waiting 5 more minutes changes a suppression list.
    //
    // (A narrower pre-existing imprecision: a lead skipped because a
    // concurrent write already claimed its step-0 slot also lands here,
    // same as it unconditionally became 'contacted' before this change —
    // not a new regression, and case-level write concurrency is out of
    // scope for this fix.)
    await updateCaseWaiting(supabase, input.caseId, 'no_viable_leads')
  }

  await logEventSafe({
    clientId: input.clientId,
    caseId: input.caseId,
    actor: ACTOR,
    type: 'pipeline.write.completed',
    payload: { caseId: input.caseId, sent, drafted, leadCount: leads.length },
  })
  return { caseId: input.caseId, drafted, sent }
}
