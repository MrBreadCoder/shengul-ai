// Read-only comparison tool: pulls up to N already-generated first-touch
// outbound emails from the DB and reruns write.ts's exact generation path
// (SYSTEM_PROMPT + buildPrompt, both exported from write.ts for this reason)
// against the same dossier, so the current HUMAN_VOICE_INSTRUCTION can be
// judged against what actually shipped. Never writes to the DB and never
// sends anything — it only calls the same generateJson step write.ts uses,
// prints the before/after, and exits.
//
//   pnpm regenerate-sample-emails                  # 2 most recent, any client
//   pnpm regenerate-sample-emails --count=5
//   pnpm regenerate-sample-emails --client-id=<uuid>
//
// Static imports here are limited to packages and type-only app imports.
// Every app module that transitively reads @/lib/env (generateJson, the db/
// and knowledge/ helpers, write.ts itself) is dynamically imported inside
// main(), AFTER .env.local is loaded — @/lib/env-public.ts validates
// NEXT_PUBLIC_* vars eagerly at module-evaluation time, and static imports
// resolve before this file's own top-level code runs, so importing those
// modules statically would throw CONFIG_ERROR before loadEnv() ever executes.
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import type { Database } from '../src/types/database'
import { AppError } from '../src/lib/errors/app-error'
import type { RunWriteInput } from '../src/lib/pipeline/write'

const FIRST_TOUCH_STEP = 0
const DEFAULT_COUNT = 2
const ACTOR = 'regenerate_sample_emails_script'

const envSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
})

const argsSchema = z.object({
  count: z.number().int().min(1).max(20),
  clientId: z.string().uuid().nullable(),
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

interface SampleEmail {
  id: string
  caseId: string
  leadId: string
  clientId: string
  subject: string
  body: string
}

// Most recent first-touch outbound emails that still have a resolvable
// lead/case (older seed rows can be orphaned) — plain rows, not the
// EmailRow type, since this only selects the columns it needs.
async function fetchSampleEmails(
  supabase: SupabaseClient<Database>,
  args: Args,
): Promise<SampleEmail[]> {
  let query = supabase
    .from('emails')
    .select('id, case_id, lead_id, client_id, subject, body')
    .eq('direction', 'outbound')
    .eq('sequence_step', FIRST_TOUCH_STEP)
    .not('case_id', 'is', null)
    .not('lead_id', 'is', null)
    .order('created_at', { ascending: false })
    .limit(args.count * 3) // over-fetch: some rows may fail to rehydrate context below
  if (args.clientId) query = query.eq('client_id', args.clientId)

  const { data, error } = await query
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to list sample emails', { cause: error.message })
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

interface RegeneratedPair {
  original: SampleEmail
  regenerated: { subject: string; body: string }
}

// Everything reused from write.ts / the db and knowledge layers, resolved via
// dynamic import once .env.local is loaded (see header comment).
interface AppDeps {
  generateJson: typeof import('../src/lib/llm/client').generateJson
  draftSchema: typeof import('../src/lib/pipeline/draft-schema').draftSchema
  buildSystemPrompt: typeof import('../src/lib/pipeline/write').buildSystemPrompt
  getEmailStyleById: typeof import('../src/lib/db/email-styles').getEmailStyleById
  getDefaultEmailStyle: typeof import('../src/lib/db/email-styles').getDefaultEmailStyle
  EMAIL_WRITER_MODEL_ID: string
  MAX_OUTPUT_TOKENS: number
  buildPrompt: typeof import('../src/lib/pipeline/write').buildPrompt
  listKnowledgeForCase: typeof import('../src/lib/db/case-knowledge').listKnowledgeForCase
  getLeadById: typeof import('../src/lib/db/leads').getLeadById
  getCaseById: typeof import('../src/lib/db/cases').getCaseById
  getCampaignForCase: typeof import('../src/lib/db/campaigns').getCampaignForCase
  getClientById: typeof import('../src/lib/db/clients').getClientById
}

async function loadAppDeps(): Promise<AppDeps> {
  const [writeMod, llmMod, schemaMod, caseKnowledgeMod, leadsMod, casesMod, campaignsMod, clientsMod, emailStylesMod] =
    await Promise.all([
      import('../src/lib/pipeline/write'),
      import('../src/lib/llm/client'),
      import('../src/lib/pipeline/draft-schema'),
      import('../src/lib/db/case-knowledge'),
      import('../src/lib/db/leads'),
      import('../src/lib/db/cases'),
      import('../src/lib/db/campaigns'),
      import('../src/lib/db/clients'),
      import('../src/lib/db/email-styles'),
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
    listKnowledgeForCase: caseKnowledgeMod.listKnowledgeForCase,
    getLeadById: leadsMod.getLeadById,
    getCaseById: casesMod.getCaseById,
    getCampaignForCase: campaignsMod.getCampaignForCase,
    getClientById: clientsMod.getClientById,
  }
}

async function regenerateOne(
  supabase: SupabaseClient<Database>,
  deps: AppDeps,
  sample: SampleEmail,
): Promise<RegeneratedPair | null> {
  const [kase, lead, campaign, knowledge, client] = await Promise.all([
    deps.getCaseById(supabase, sample.caseId),
    deps.getLeadById(supabase, sample.leadId),
    deps.getCampaignForCase(supabase, sample.caseId),
    deps.listKnowledgeForCase(supabase, sample.caseId),
    deps.getClientById(supabase, sample.clientId),
  ])
  if (!kase || !lead || !campaign) return null

  const input: RunWriteInput = {
    clientId: sample.clientId,
    campaignId: campaign.id,
    caseId: sample.caseId,
    replyMode: campaign.reply_mode,
    valueProp: campaign.value_prop,
    bookingLink: campaign.booking_link,
    mailboxIds: campaign.mailbox_ids,
    companyName: kase.company_name,
  }

  const clientStyle = client?.email_style_id ? await deps.getEmailStyleById(supabase, client.email_style_id) : null
  const style = clientStyle ?? (await deps.getDefaultEmailStyle(supabase))

  const draft = await deps.generateJson(
    { clientId: sample.clientId, caseId: sample.caseId, actor: ACTOR },
    {
      instructions: deps.buildSystemPrompt(style.voice_instructions),
      prompt: deps.buildPrompt(input, lead, knowledge, client),
      schema: deps.draftSchema,
      maxOutputTokens: deps.MAX_OUTPUT_TOKENS,
      modelId: deps.EMAIL_WRITER_MODEL_ID,
      // Matches write.ts's real thinking level so this script's output stays
      // representative of what the live pipeline actually generates.
      thinkingLevel: 'medium',
    },
  )

  return { original: sample, regenerated: draft }
}

// Cheap heuristic scan for the tells HUMAN_VOICE_INSTRUCTION bans — not a
// substitute for reading the output, just a fast visual flag in the diff.
const TELLS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: 'em/en dash', pattern: /[—–]/ },
  { label: 'hope this email finds you', pattern: /hope (this|you)/i },
  { label: 'reach out / touch base / circle back', pattern: /reach out|touch base|circle back/i },
  { label: 'leverage / synergy / seamless', pattern: /\bleverage\b|\bsynergy\b|\bseamless\b/i },
  { label: 'rhetorical opener (Honestly?/Look,)', pattern: /\bhonestly\?|^look,|here's the thing/i },
]

function scanForTells(text: string): string[] {
  return TELLS.filter((tell) => tell.pattern.test(text)).map((tell) => tell.label)
}

function printPair(pair: RegeneratedPair, index: number): void {
  const { original, regenerated } = pair
  console.log(`\n${'='.repeat(72)}`)
  console.log(`SAMPLE ${index + 1} — email ${original.id} (case ${original.caseId})`)
  console.log('='.repeat(72))

  console.log('\n--- ORIGINAL (as stored) ---')
  console.log(`Subject: ${original.subject}`)
  console.log(original.body)
  const originalTells = scanForTells(`${original.subject}\n${original.body}`)
  console.log(`Tells found: ${originalTells.length > 0 ? originalTells.join(', ') : 'none'}`)

  console.log('\n--- REGENERATED (current prompt) ---')
  console.log(`Subject: ${regenerated.subject}`)
  console.log(regenerated.body)
  const regeneratedTells = scanForTells(`${regenerated.subject}\n${regenerated.body}`)
  console.log(`Tells found: ${regeneratedTells.length > 0 ? regeneratedTells.join(', ') : 'none'}`)
}

// src/lib/env.ts validates the FULL app env schema eagerly on import (by
// design — fail-fast startup for the Next.js app), including integrations
// this script never touches (Bright Data, QStash, Apollo, mailbox OAuth). A
// var required by that schema but genuinely absent from this machine's
// .env.local (BRIGHTDATA_SERP_ZONE, as of this script's writing) would abort
// generateJson's import chain before a single email gets regenerated. Backfill
// process.env only, only for this process, only for vars that schema
// requires but this script's code path never reads — never written to disk.
const UNUSED_BUT_REQUIRED_ENV_DEFAULTS: Record<string, string> = {
  BRIGHTDATA_SERP_ZONE: 'unused-by-regenerate-sample-emails',
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

  const samples = await fetchSampleEmails(supabase, args)
  if (samples.length === 0) {
    console.log('No first-touch outbound emails found to sample.')
    return
  }

  const pairs: RegeneratedPair[] = []
  for (const sample of samples) {
    if (pairs.length >= args.count) break
    const pair = await regenerateOne(supabase, deps, sample)
    if (pair) pairs.push(pair)
  }

  if (pairs.length === 0) {
    console.log('Found candidate emails but none had a resolvable case/lead/campaign to regenerate against.')
    return
  }

  pairs.forEach(printPair)
  console.log(`\n${'='.repeat(72)}`)
  console.log(`Regenerated ${pairs.length} of ${args.count} requested.`)
}

main().catch((error) => {
  if (error instanceof AppError) {
    console.error(`[${error.code}] ${error.message}`, error.context)
  } else {
    console.error(error)
  }
  process.exitCode = 1
})
