// One-off operational script: re-runs REAL research (runResearchForCase,
// unmodified — the exact function /api/pipeline/research invokes) against a
// hardcoded list of cases whose original research run (2026-08-18, the
// Bright Data concurrency-starvation incident — see .claude/roadmap.md) came
// back with nothing but the Apollo firmographics line, then regenerates
// their existing first-touch draft in place using the newly-gathered
// dossier — the exact same claim-guarded updateDraftContent path
// rewrite-draft-emails.ts uses, so a draft that's since been sent or
// otherwise claimed is safely skipped, never overwritten.
//
// Scoped to specific case IDs (not a client-wide sweep, unlike
// rewrite-draft-emails.ts) because this client has other, healthy cases from
// the same incident that don't need touching.
//
// Bypasses research/route.ts's `status === 'new'` gate deliberately — same
// stance as run-discovery-live.ts bypassing its own route's active-campaign
// gate: this is a deliberate manual re-run, not the cron path.
//
//   pnpm tsx scripts/redo-research-and-drafts.ts               # dry run (prints only)
//   pnpm tsx scripts/redo-research-and-drafts.ts --apply        # writes knowledge + draft content
//
// Static imports here are limited to packages and type-only app imports —
// every app module that transitively reads @/lib/env is dynamically
// imported inside main(), AFTER .env.local is loaded (same reason as
// rewrite-draft-emails.ts's header comment).
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '../src/types/database'
import { AppError } from '../src/lib/errors/app-error'

const ACTOR = 'redo_research_and_drafts_script'

// The 7 cases from the 2026-08-18 20:05-20:10 UTC batch whose research
// completed with knowledgeCount: 0 (agent + social both came back empty
// during the Bright Data congestion) — everything they have today is just
// the Apollo firmographics line captured at discovery time, not real
// research. Excludes CBP/DHS/CATRION from the same incident, which got a
// real dossier (8-11 facts) once the queue drained and don't need a redo.
const TARGET_CASE_IDS: readonly string[] = [
  'eb9b97f8-c5ca-4f7c-8790-9eb1953ec58c', // Panda Hotel
  '5c468716-a0e2-4a32-a071-990d86528209', // Elkhart Police Department
  'a1a0c06d-9a92-4178-b624-a50d12d2254f', // The Surrey, A Corinthia Hotel
  'f33c3616-0e20-4b5c-9fa6-3488a2f70a3b', // Farmington Police Department
  '9c3d862c-8e65-485b-89e0-d63b27dc6c36', // Naples Airport Authority
  'e229c81b-a47c-4f75-98b6-117d869f4d79', // UPS
  '5b7fbcca-e177-446d-aaa0-1c03fc616140', // The Courier Company
]

function loadEnv(): { url: string; key: string } {
  try {
    process.loadEnvFile('.env.local')
  } catch {
    // No .env.local — fall through to whatever is already in process.env.
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    throw new AppError('CONFIG_ERROR', 'Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY', {})
  }
  return { url, key }
}

// src/lib/env.ts validates the full app env schema eagerly on import — same
// backfill pattern as rewrite-draft-emails.ts's header note, needed only
// because this process never sets these (research/write paths do use them
// for real, unlike that script).
const REQUIRED_BUT_ALREADY_SET = [
  'BRIGHTDATA_API_KEY', 'BRIGHTDATA_SERP_ZONE', 'BRIGHTDATA_SCRAPE_ZONE', 'GEMINI_API_KEY',
]

async function loadAppDeps() {
  const [
    researchMod, brightdataMod, casesMod, leadsMod, campaignsMod, clientsMod,
    formatCompanyMod, writeMod, llmMod, schemaMod, signatureMod, caseKnowledgeMod, emailsMod,
  ] = await Promise.all([
    import('../src/lib/pipeline/research'),
    import('../src/lib/research/brightdata'),
    import('../src/lib/db/cases'),
    import('../src/lib/db/leads'),
    import('../src/lib/db/campaigns'),
    import('../src/lib/db/clients'),
    import('../src/lib/apollo/format-company-summary'),
    import('../src/lib/pipeline/write'),
    import('../src/lib/llm/client'),
    import('../src/lib/pipeline/draft-schema'),
    import('../src/lib/pipeline/signature'),
    import('../src/lib/db/case-knowledge'),
    import('../src/lib/db/emails'),
  ])
  return {
    runResearchForCase: researchMod.runResearchForCase,
    brightdataResearch: brightdataMod.brightdataResearch,
    getCaseById: casesMod.getCaseById,
    updateCaseWaiting: casesMod.updateCaseWaiting,
    listActiveLeadsForCase: leadsMod.listActiveLeadsForCase,
    getLeadById: leadsMod.getLeadById,
    getCampaignForCase: campaignsMod.getCampaignForCase,
    getClientById: clientsMod.getClientById,
    parseCompanyFirmographicsFromRaw: formatCompanyMod.parseCompanyFirmographicsFromRaw,
    parseCompanySocialsFromRaw: formatCompanyMod.parseCompanySocialsFromRaw,
    parsePersonSocialsFromRaw: formatCompanyMod.parsePersonSocialsFromRaw,
    buildSystemPrompt: writeMod.buildSystemPrompt,
    buildPrompt: writeMod.buildPrompt,
    resolveEmailTemplate: writeMod.resolveEmailTemplate,
    EMAIL_WRITER_MODEL_ID: writeMod.EMAIL_WRITER_MODEL_ID,
    MAX_OUTPUT_TOKENS: writeMod.MAX_OUTPUT_TOKENS,
    generateJson: llmMod.generateJson,
    draftSchema: schemaMod.draftSchema,
    appendSignatureBlock: signatureMod.appendSignatureBlock,
    resolveSignatureContext: signatureMod.resolveSignatureContext,
    listKnowledgeForCase: caseKnowledgeMod.listKnowledgeForCase,
    updateDraftContent: emailsMod.updateDraftContent,
  }
}
type AppDeps = Awaited<ReturnType<typeof loadAppDeps>>

async function redoResearch(
  supabase: SupabaseClient<Database>,
  deps: AppDeps,
  caseId: string,
): Promise<{ ok: true; knowledgeCount: number } | { ok: false; reason: string }> {
  const kase = await deps.getCaseById(supabase, caseId)
  if (!kase) return { ok: false, reason: 'case not found' }
  const campaign = await deps.getCampaignForCase(supabase, caseId)
  if (!campaign) return { ok: false, reason: 'campaign not found' }
  const leads = await deps.listActiveLeadsForCase(supabase, caseId)
  if (leads.length === 0) return { ok: false, reason: 'no active leads' }
  const client = await deps.getClientById(supabase, kase.client_id)

  const companyFirmographics = deps.parseCompanyFirmographicsFromRaw(leads[0]!.raw)
  const companySocials = deps.parseCompanySocialsFromRaw(leads[0]!.raw)

  try {
    const summary = await deps.runResearchForCase(
      supabase,
      { research: deps.brightdataResearch },
      {
        clientId: kase.client_id,
        caseId,
        companyName: kase.company_name,
        companyDomain: kase.company_domain,
        companyFirmographics,
        companySocials,
        leads: leads.map((l) => {
          const { twitterUrl } = deps.parsePersonSocialsFromRaw(l.raw)
          return { id: l.id, fullName: l.full_name, title: l.title, linkedinUrl: l.linkedin_url, twitterUrl }
        }),
        seller: {
          name: client?.name ?? null,
          companyInfo: client?.company_info ?? null,
          valueProp: campaign.value_prop,
        },
      },
    )
    return { ok: true, knowledgeCount: summary.knowledgeCount }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

async function rewriteDraftsForCase(
  supabase: SupabaseClient<Database>,
  deps: AppDeps,
  caseId: string,
  apply: boolean,
): Promise<void> {
  const kase = await deps.getCaseById(supabase, caseId)
  const campaign = await deps.getCampaignForCase(supabase, caseId)
  if (!kase || !campaign) {
    console.log(`  [skip] ${caseId} — case or campaign missing.`)
    return
  }
  const client = await deps.getClientById(supabase, kase.client_id)
  const knowledge = await deps.listKnowledgeForCase(supabase, caseId)
  const template = await deps.resolveEmailTemplate(supabase, campaign.email_template_id, client)

  const { data: drafts, error } = await supabase
    .from('emails')
    .select('id, lead_id, subject, body')
    .eq('case_id', caseId)
    .eq('direction', 'outbound')
    .eq('status', 'draft')
    .eq('sequence_step', 0)
  if (error) throw new AppError('DB_ERROR', 'Failed to list drafts for case', { caseId, cause: error.message })

  for (const draft of drafts ?? []) {
    if (!draft.lead_id) continue
    const lead = await deps.getLeadById(supabase, draft.lead_id)
    if (!lead) continue
    try {
      await rewriteOneDraft(supabase, deps, { kase, campaign, client, knowledge, template, draft, lead, apply })
    } catch (error) {
      // One lead's transient failure (Gemini overload, timeout) must not
      // abort the rest of the batch — same "one bad agent doesn't sink the
      // run" stance runResearchForCase takes with Promise.allSettled.
      console.log(`  [FAILED] ${kase.company_name} / ${lead.full_name} — ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  if (apply) {
    // These cases currently read 'contacted' from the pre-migration
    // unconditional-contacted bug (nothing was ever actually sent — every
    // draft here has sent_at: null). Correct that to the real state now
    // that migration 0049/0050 (case_status='waiting' + wait_reason) is
    // live: a fresh draft sitting in /inbox awaiting a human's approval.
    await deps.updateCaseWaiting(supabase, caseId, 'awaiting_manual_approval')
    console.log(`  [status] ${caseId} corrected: contacted -> waiting/awaiting_manual_approval`)
  }
}

async function rewriteOneDraft(
  supabase: SupabaseClient<Database>,
  deps: AppDeps,
  ctx: {
    kase: NonNullable<Awaited<ReturnType<AppDeps['getCaseById']>>>
    campaign: NonNullable<Awaited<ReturnType<AppDeps['getCampaignForCase']>>>
    client: Awaited<ReturnType<AppDeps['getClientById']>>
    knowledge: Awaited<ReturnType<AppDeps['listKnowledgeForCase']>>
    template: Awaited<ReturnType<AppDeps['resolveEmailTemplate']>>
    draft: { id: string; lead_id: string | null; subject: string | null; body: string | null }
    lead: NonNullable<Awaited<ReturnType<AppDeps['getLeadById']>>>
    apply: boolean
  },
): Promise<void> {
  const { kase, campaign, client, knowledge, template, draft, lead, apply } = ctx
  const leadKnowledge = knowledge.filter((k) => (k.lead_id ?? null) === null || k.lead_id === lead.id)
  const input = {
    clientId: kase.client_id,
    campaignId: campaign.id,
    caseId: kase.id,
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
  }

  const generated = await deps.generateJson(
    { clientId: kase.client_id, caseId: kase.id, actor: ACTOR },
    {
      instructions: deps.buildSystemPrompt(template.template_text),
      prompt: deps.buildPrompt(input, lead, leadKnowledge, client),
      schema: deps.draftSchema,
      maxOutputTokens: deps.MAX_OUTPUT_TOKENS,
      modelId: deps.EMAIL_WRITER_MODEL_ID,
      thinkingLevel: 'medium',
    },
  )
  const signedBody = deps.appendSignatureBlock(
    generated.body,
    deps.resolveSignatureContext(client, {
      signatureName: input.signatureName,
      signatureTitle: input.signatureTitle,
      phone: input.signaturePhone,
      address: input.signatureAddress,
    }),
  )

  console.log(`\n  --- ${kase.company_name} / ${lead.full_name} ---`)
  console.log(`  BEFORE subject: ${draft.subject}`)
  console.log(`  AFTER  subject: ${generated.subject}`)
  console.log(`  AFTER  body:\n${signedBody.split('\n').map((l) => `    ${l}`).join('\n')}`)

  if (!apply) return
  const updated = await deps.updateDraftContent(supabase, draft.id, { subject: generated.subject, body: signedBody })
  if (!updated) {
    console.log(`  [skip] ${draft.id} was no longer a draft (already sent/claimed elsewhere) — not overwritten.`)
  } else {
    console.log(`  [written] draft ${draft.id} updated.`)
  }
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply')
  const { url, key } = loadEnv()
  for (const envKey of REQUIRED_BUT_ALREADY_SET) {
    if (!process.env[envKey]) {
      throw new AppError('CONFIG_ERROR', `Missing required env var ${envKey} — this script calls the real research/write pipeline.`, {})
    }
  }
  const deps = await loadAppDeps()
  const supabase = createClient<Database>(url, key, { auth: { persistSession: false } })

  console.log(`Mode: ${apply ? 'APPLY (writing to DB)' : 'DRY RUN (research still runs + costs API calls; draft rewrite prints only)'}`)
  console.log(`Re-researching ${TARGET_CASE_IDS.length} case(s)...\n`)

  const researchResults = await Promise.allSettled(
    TARGET_CASE_IDS.map(async (caseId) => {
      const result = await redoResearch(supabase, deps, caseId)
      if (result.ok) {
        console.log(`[research ok] ${caseId} — +${result.knowledgeCount} knowledge row(s)`)
      } else {
        console.log(`[research FAILED] ${caseId} — ${result.reason}`)
      }
      return { caseId, result }
    }),
  )

  const succeeded = researchResults
    .filter((r): r is PromiseFulfilledResult<{ caseId: string; result: { ok: true; knowledgeCount: number } }> =>
      r.status === 'fulfilled' && r.value.result.ok,
    )
    .map((r) => r.value.caseId)

  console.log(`\nResearch done: ${succeeded.length}/${TARGET_CASE_IDS.length} succeeded. Rewriting drafts for the successful ones...\n`)

  for (const caseId of succeeded) {
    await rewriteDraftsForCase(supabase, deps, caseId, apply)
  }

  console.log(`\nDone. ${apply ? 'Changes written.' : 'Dry run only — re-run with --apply to persist.'}`)
}

main().catch((error) => {
  if (error instanceof AppError) {
    console.error(`[${error.code}] ${error.message}`, error.context)
  } else {
    console.error(error)
  }
  process.exitCode = 1
})
