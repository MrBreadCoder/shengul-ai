// Mutating counterpart to regenerate-sample-emails.ts: regenerates and
// PERSISTS the subject/body of first-touch outbound drafts (status='draft',
// sequence_step=0 — human_approve/hybrid emails an operator hasn't sent yet)
// using write.ts's exact current generation path (buildSystemPrompt +
// buildPrompt + the deterministic signature block), so a client's queued
// drafts reflect the latest prompt (e.g. after switching email_style).
//
// Defaults to a dry run — it prints the regenerated subject/body for every
// matching draft but writes nothing. Pass --apply to actually persist,
// through the same claim-guarded updateDraftContent write path a manual
// Save or an AI Redesign in /inbox uses (a draft claimed/sent concurrently
// is skipped, never overwritten).
//
// Deliberately does NOT touch lead/email verification (Emailable/Apollo) or
// send anything — it only rewrites stored draft content already grounded in
// the case's existing dossier.
//
//   pnpm rewrite-draft-emails --client-id=<uuid>                # dry run
//   pnpm rewrite-draft-emails --client-id=<uuid> --apply         # persists
//   pnpm rewrite-draft-emails --client-id=<uuid> --count=50 --apply
//   pnpm rewrite-draft-emails --client-id=<uuid> --model-id=gemini-3.6-flash  # try a different model, dry run
//
// Static imports here are limited to packages and type-only app imports, for
// the same reason as regenerate-sample-emails.ts: every app module that
// transitively reads @/lib/env is dynamically imported inside main(), AFTER
// .env.local is loaded, since @/lib/env-public.ts validates NEXT_PUBLIC_*
// vars eagerly at module-evaluation time and a static import would resolve
// before this file's own top-level code runs.
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import type { Database } from '../src/types/database'
import { AppError } from '../src/lib/errors/app-error'
import type { RunWriteInput } from '../src/lib/pipeline/write'
import type { ClientSignatureContext } from '../src/lib/pipeline/signature'

const FIRST_TOUCH_STEP = 0
const DEFAULT_COUNT = 20
const ACTOR = 'rewrite_draft_emails_script'

const envSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
})

const argsSchema = z.object({
  count: z.number().int().min(1).max(200),
  clientId: z.string().uuid().nullable(),
  apply: z.boolean(),
  // Overrides generateJson's module-default model (gemini-3-flash-preview,
  // see src/lib/llm/client.ts) for this run only — e.g. to compare a newer
  // model's output before adopting it as the default anywhere.
  modelId: z.string().nullable(),
})
type Args = z.infer<typeof argsSchema>

function parseArgs(argv: readonly string[]): Args {
  const values = new Map(
    argv
      .filter((arg) => arg.includes('='))
      .map((arg) => {
        const separator = arg.indexOf('=')
        return [arg.slice(0, separator), arg.slice(separator + 1)] as const
      }),
  )
  const rawCount = values.get('--count')
  const parsed = argsSchema.safeParse({
    count: rawCount === undefined ? DEFAULT_COUNT : Number(rawCount),
    clientId: values.get('--client-id') ?? null,
    apply: argv.includes('--apply'),
    modelId: values.get('--model-id') ?? null,
  })
  if (!parsed.success) {
    throw new AppError('VALIDATION_ERROR', `Invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join(', ')}`, {})
  }
  return parsed.data
}

function loadEnv(): z.infer<typeof envSchema> {
  try {
    process.loadEnvFile('.env.local')
  } catch {
    // No .env.local — fall through to whatever is already in process.env.
  }
  const parsed = envSchema.safeParse(process.env)
  if (!parsed.success) {
    throw new AppError('CONFIG_ERROR', 'Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY', {
      issues: parsed.error.issues.map((issue) => issue.path.join('.')),
    })
  }
  return parsed.data
}

interface DraftEmail {
  id: string
  caseId: string
  leadId: string
  clientId: string
  subject: string
  body: string
}

// Only first-touch, still-draft, outbound emails — never a sent email
// (rewriting sent history would be misleading) and never a follow-up nudge
// (out of scope: email_style only governs write.ts's first-touch prompt).
async function fetchDraftEmails(supabase: SupabaseClient<Database>, args: Args): Promise<DraftEmail[]> {
  let query = supabase
    .from('emails')
    .select('id, case_id, lead_id, client_id, subject, body')
    .eq('direction', 'outbound')
    .eq('status', 'draft')
    .eq('sequence_step', FIRST_TOUCH_STEP)
    .not('case_id', 'is', null)
    .not('lead_id', 'is', null)
    .order('created_at', { ascending: true })
    .limit(args.count)
  if (args.clientId) query = query.eq('client_id', args.clientId)

  const { data, error } = await query
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to list draft emails', { cause: error.message })
  }
  return (data ?? [])
    .filter((row): row is typeof row & { case_id: string; lead_id: string } => row.case_id !== null && row.lead_id !== null)
    .map((row) => ({
      id: row.id,
      caseId: row.case_id,
      leadId: row.lead_id,
      clientId: row.client_id,
      subject: row.subject ?? '(no subject)',
      body: row.body ?? '(no body)',
    }))
}

interface RewriteResult {
  draft: DraftEmail
  regenerated: { subject: string; body: string }
  applied: boolean
}

// Everything reused from write.ts / the db, knowledge, and signature layers,
// resolved via dynamic import once .env.local is loaded (see header comment).
interface AppDeps {
  generateJson: typeof import('../src/lib/llm/client').generateJson
  draftSchema: typeof import('../src/lib/pipeline/draft-schema').draftSchema
  buildSystemPrompt: typeof import('../src/lib/pipeline/write').buildSystemPrompt
  getEmailStyleById: typeof import('../src/lib/db/email-styles').getEmailStyleById
  getDefaultEmailStyle: typeof import('../src/lib/db/email-styles').getDefaultEmailStyle
  EMAIL_WRITER_MODEL_ID: string
  MAX_OUTPUT_TOKENS: number
  buildPrompt: typeof import('../src/lib/pipeline/write').buildPrompt
  appendSignatureBlock: typeof import('../src/lib/pipeline/signature').appendSignatureBlock
  listKnowledgeForCase: typeof import('../src/lib/db/case-knowledge').listKnowledgeForCase
  getLeadById: typeof import('../src/lib/db/leads').getLeadById
  getCaseById: typeof import('../src/lib/db/cases').getCaseById
  getCampaignForCase: typeof import('../src/lib/db/campaigns').getCampaignForCase
  getClientById: typeof import('../src/lib/db/clients').getClientById
  updateDraftContent: typeof import('../src/lib/db/emails').updateDraftContent
}

async function loadAppDeps(): Promise<AppDeps> {
  const [writeMod, llmMod, schemaMod, signatureMod, caseKnowledgeMod, leadsMod, casesMod, campaignsMod, clientsMod, emailStylesMod, emailsMod] =
    await Promise.all([
      import('../src/lib/pipeline/write'),
      import('../src/lib/llm/client'),
      import('../src/lib/pipeline/draft-schema'),
      import('../src/lib/pipeline/signature'),
      import('../src/lib/db/case-knowledge'),
      import('../src/lib/db/leads'),
      import('../src/lib/db/cases'),
      import('../src/lib/db/campaigns'),
      import('../src/lib/db/clients'),
      import('../src/lib/db/email-styles'),
      import('../src/lib/db/emails'),
    ])
  return {
    generateJson: llmMod.generateJson,
    draftSchema: schemaMod.draftSchema,
    buildSystemPrompt: writeMod.buildSystemPrompt,
    getEmailStyleById: emailStylesMod.getEmailStyleById,
    getDefaultEmailStyle: emailStylesMod.getDefaultEmailStyle,
    EMAIL_WRITER_MODEL_ID: writeMod.EMAIL_WRITER_MODEL_ID,
    MAX_OUTPUT_TOKENS: writeMod.MAX_OUTPUT_TOKENS,
    buildPrompt: writeMod.buildPrompt,
    appendSignatureBlock: signatureMod.appendSignatureBlock,
    listKnowledgeForCase: caseKnowledgeMod.listKnowledgeForCase,
    getLeadById: leadsMod.getLeadById,
    getCaseById: casesMod.getCaseById,
    getCampaignForCase: campaignsMod.getCampaignForCase,
    getClientById: clientsMod.getClientById,
    updateDraftContent: emailsMod.updateDraftContent,
  }
}

function toSignatureContext(client: { name: string; signature_name: string | null; signature_title: string | null; phone: string | null; address: string | null; domain: string | null } | null): ClientSignatureContext {
  return {
    companyName: client?.name ?? '',
    signatureName: client?.signature_name ?? null,
    signatureTitle: client?.signature_title ?? null,
    phone: client?.phone ?? null,
    address: client?.address ?? null,
    domain: client?.domain ?? null,
  }
}

async function regenerateAndMaybeApply(
  supabase: SupabaseClient<Database>,
  deps: AppDeps,
  draft: DraftEmail,
  apply: boolean,
  modelId: string | null,
): Promise<RewriteResult | null> {
  const [kase, lead, campaign, knowledge, client] = await Promise.all([
    deps.getCaseById(supabase, draft.caseId),
    deps.getLeadById(supabase, draft.leadId),
    deps.getCampaignForCase(supabase, draft.caseId),
    deps.listKnowledgeForCase(supabase, draft.caseId),
    deps.getClientById(supabase, draft.clientId),
  ])
  if (!kase || !lead || !campaign) return null

  const input: RunWriteInput = {
    clientId: draft.clientId,
    campaignId: campaign.id,
    caseId: draft.caseId,
    replyMode: campaign.reply_mode,
    valueProp: campaign.value_prop,
    bookingLink: campaign.booking_link,
    mailboxIds: campaign.mailbox_ids,
    companyName: kase.company_name,
  }

  const clientStyle = client?.email_style_id ? await deps.getEmailStyleById(supabase, client.email_style_id) : null
  const style = clientStyle ?? (await deps.getDefaultEmailStyle(supabase))

  const generated = await deps.generateJson(
    { clientId: draft.clientId, caseId: draft.caseId, actor: ACTOR },
    {
      instructions: deps.buildSystemPrompt(style.voice_instructions),
      prompt: deps.buildPrompt(input, lead, knowledge, client),
      schema: deps.draftSchema,
      maxOutputTokens: deps.MAX_OUTPUT_TOKENS,
      // --model-id overrides for an experimental comparison; otherwise match
      // write.ts's real default so this script's output stays representative.
      modelId: modelId ?? deps.EMAIL_WRITER_MODEL_ID,
      // Matches write.ts's real thinking level so this script's output stays
      // representative of what the live pipeline actually generates.
      thinkingLevel: 'medium',
    },
  )

  const signedBody = deps.appendSignatureBlock(generated.body, toSignatureContext(client))
  const regenerated = { subject: generated.subject, body: signedBody }

  if (!apply) return { draft, regenerated, applied: false }

  const updated = await deps.updateDraftContent(supabase, draft.id, regenerated)
  if (!updated) {
    console.warn(`  [skip] ${draft.id} was no longer a draft (already sent/claimed elsewhere) — not overwritten.`)
    return { draft, regenerated, applied: false }
  }
  return { draft, regenerated, applied: true }
}

function printResult(result: RewriteResult): void {
  const { draft, regenerated, applied } = result
  console.log(`\n${'='.repeat(72)}`)
  console.log(`${applied ? '[written]' : '[preview]'} draft ${draft.id} (case ${draft.caseId})`)
  console.log('='.repeat(72))
  console.log('\n--- BEFORE ---')
  console.log(`Subject: ${draft.subject}`)
  console.log(draft.body)
  console.log('\n--- AFTER ---')
  console.log(`Subject: ${regenerated.subject}`)
  console.log(regenerated.body)
}

// src/lib/env.ts validates the FULL app env schema eagerly on import — see
// regenerate-sample-emails.ts's identical header note. Same backfill needed
// for this process only, never written to disk.
const UNUSED_BUT_REQUIRED_ENV_DEFAULTS: Record<string, string> = {
  BRIGHTDATA_SERP_ZONE: 'unused-by-rewrite-draft-emails',
}

function backfillUnrelatedRequiredEnv(): void {
  for (const [key, placeholder] of Object.entries(UNUSED_BUT_REQUIRED_ENV_DEFAULTS)) {
    if (process.env[key]) continue
    process.env[key] = placeholder
    console.warn(`[env] ${key} not set locally; using an in-process placeholder (this script never reads it).`)
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const env = loadEnv()
  backfillUnrelatedRequiredEnv()
  const deps = await loadAppDeps()
  const supabase = createClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  })

  const drafts = await fetchDraftEmails(supabase, args)
  if (drafts.length === 0) {
    console.log('No first-touch draft emails found to rewrite.')
    return
  }

  console.log(
    `Found ${drafts.length} draft(s). Mode: ${args.apply ? 'APPLY (writing to DB)' : 'DRY RUN (preview only — pass --apply to write)'}` +
      (args.modelId ? ` | Model override: ${args.modelId}` : ''),
  )

  let appliedCount = 0
  let skippedCount = 0
  for (const draft of drafts) {
    const result = await regenerateAndMaybeApply(supabase, deps, draft, args.apply, args.modelId)
    if (!result) {
      skippedCount += 1
      console.log(`\n[skip] ${draft.id} — missing case/lead/campaign, cannot rehydrate context.`)
      continue
    }
    printResult(result)
    if (result.applied) appliedCount += 1
    else if (args.apply) skippedCount += 1
  }

  console.log(`\n${'='.repeat(72)}`)
  if (args.apply) {
    console.log(`Rewrote ${appliedCount} of ${drafts.length} draft(s) in the DB. Skipped: ${skippedCount}.`)
  } else {
    console.log(`Previewed ${drafts.length} draft(s), wrote nothing. Re-run with --apply to persist.`)
  }
}

main().catch((error) => {
  if (error instanceof AppError) {
    console.error(`[${error.code}] ${error.message}`, error.context)
  } else {
    console.error(error)
  }
  process.exitCode = 1
})
