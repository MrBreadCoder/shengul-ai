// Standalone smoke test: runs write.ts's exact generation path (buildSystemPrompt +
// buildPrompt + generateJson, same args processLead() uses) against a fully synthetic
// lead/client/dossier — no DB reads, no DB writes, nothing sent. Lets you see exactly
// what the live email-writer prompt produces without needing a real case in the
// database. Prints the system prompt, the user prompt, the raw model output, the final
// signed body (via the same appendSignatureBlock() a real send would use), and the
// same cliché/tell scan regenerate-sample-emails.ts uses.
//
//   pnpm test-fake-email                       # concise (default) template
//   pnpm test-fake-email --template=formal     # formal introduction template
//
// Static imports here are limited to packages and type-only app imports — every app
// module that transitively reads @/lib/env (generateJson itself) is dynamically
// imported inside main(), AFTER .env.local is loaded, matching the pattern
// regenerate-sample-emails.ts uses and for the same reason (see that file's header).
import { z } from 'zod'
import { AppError } from '../src/lib/errors/app-error'
import type { RunWriteInput } from '../src/lib/pipeline/write'
import type { LeadRow } from '../src/lib/db/leads'
import type { ClientRow } from '../src/lib/db/clients'
import type { KnowledgeRow } from '../src/lib/db/case-knowledge'

const ACTOR = 'test_fake_email_script'

// Byte-for-byte copies of the two seeded rows in
// supabase/migrations/0035_email_styles_table.sql (table/column renamed to
// email_templates/template_text by 0046), as amended by
// 0038_fix_formal_intro_overclaim_and_isolation.sql, so this script exercises
// the exact wording a real client would get — not an approximation of it.
const TEMPLATE_TEXT_BY_NAME: Record<'concise' | 'formal', string> = {
  concise:
    'You write short, human-sounding B2B cold emails. One clear idea. 90 words or fewer. ' +
    'Lead with the specific dossier fact, not a greeting. ' +
    'Call to action: default to a low-friction reply question (e.g. "worth a quick reply?"), ' +
    'not the booking link. Only offer the booking link if it is clearly the natural next step — ' +
    'it is an optional extra, never the default ask.',
  formal:
    'You write a formal B2B introduction email for a manufacturer reaching out cold to a new prospect. ' +
    'Structure the body around these ideas. Weave dossier facts into the sentences that need them — ' +
    'never isolate a fact into its own flat sentence like "Company X has done Y since Z"; that reads ' +
    'like a database record, not a personal email. This applies even when only one strong fact is ' +
    'available — tie it to the capability sentence or the ask with a connecting clause ("because", ' +
    '"after", "since", "which is why") rather than letting it stand alone as its own sentence. Spread ' +
    'what you know about the recipient across multiple paragraphs below instead of stacking it all ' +
    'into one: ' +
    '1. Greeting: "Dear [Recipient first name]," using the recipient\'s first name from the Recipient ' +
    'line below; if no name is given, use "Dear," alone. ' +
    '2. Self-introduction: one sentence giving the sender name and company name exactly as given in ' +
    '"Sender name" / "Our company name" below, plus the company\'s home base and years of experience — ' +
    'only the ones you have evidence for in "About our company"; drop whichever you don\'t have ' +
    'rather than guessing. One sentence, no added claims about the sender. ' +
    '3. Capabilities: what the company manufactures or does, grounded in the value proposition and ' +
    '"About our company" below. Fold in the recipient\'s industry, sector, or location where it fits ' +
    'naturally, framed as the kind of customer you serve (e.g. "...for police and corrections agencies ' +
    'like yours in Wyoming" or "...for supermarket chains operating in humid climates") instead of ' +
    'listing capabilities generically. Never state or imply that the sender already operates, ' +
    'manufactures, or has clients in the recipient\'s country or region unless "About our company" ' +
    'explicitly says so — the recipient\'s location is an analogy for who you serve, not a claim about ' +
    'where you already work. ' +
    '4. Personalize: use the strongest available dossier fact(s) to show this is not a mass-blast — ' +
    'prefer a (pain_point) or (news) fact over a bare (company) firmographic line (industry/size/ ' +
    'founding year/location). If several strong facts are available, split them between this ' +
    'paragraph and the capabilities sentence above rather than stacking them all here. If the ' +
    'dossier has only a bare (company) firmographic line and nothing sharper, do not give it its own ' +
    'paragraph — fold that one detail (location, size, or sector) into the capabilities sentence ' +
    'above or the ask below instead, and skip this paragraph entirely. Whichever paragraph a fact ' +
    'ends up in, state it plainly; never add a claim about why it matters, what the recipient needs, ' +
    'or what is "a priority" for them — that invents something the dossier does not say. Never fall ' +
    'back to a generic line like "I came across your company", "I wanted to introduce ourselves", "I ' +
    'am reaching out to [company]", or "regarding your [X] needs". ' +
    '5. Ask: a qualifying question asking whether the recipient is the right person to discuss the ' +
    'kind of procurement or project relevant to their industry, followed by an offer to send the ' +
    'company profile, references, and product capabilities if so. Only mention the booking link ' +
    'here if it is clearly the natural next step; otherwise the offer to send materials is the ' +
    'entire ask. ' +
    'End the body immediately after the offer sentence. Do not add "Best regards," a name, or any ' +
    'sign-off — a signature block is appended separately in code. ' +
    'Four to five short paragraphs total once personalization is folded in as above. 130 words or ' +
    'fewer, including the greeting.',
}

const argsSchema = z.object({ template: z.enum(['concise', 'formal']) })

function parseArgs(argv: readonly string[]): z.infer<typeof argsSchema> {
  const raw = argv.find((arg) => arg.startsWith('--template='))?.slice('--template='.length) ?? 'concise'
  const parsed = argsSchema.safeParse({ template: raw })
  if (!parsed.success) {
    throw new AppError('VALIDATION_ERROR', `Invalid --template (expected "concise" or "formal"), got "${raw}"`, {})
  }
  return parsed.data
}

function loadEnv(): void {
  try {
    process.loadEnvFile('.env.local')
  } catch {
    // No .env.local — fall through to whatever is already in process.env.
  }
}

// Fully synthetic — never touches the database. Column shape matches the generated
// Database type exactly so this stays a faithful stand-in if the schema changes.
function buildFakeLead(): LeadRow {
  return {
    id: 'fake-lead-0000-0000-0000-000000000000',
    client_id: 'fake-client-0000-0000-0000-00000000000',
    campaign_id: 'fake-campaign-0000-0000-0000-0000000000',
    case_id: 'fake-case-0000-0000-0000-000000000000',
    full_name: 'Sarah Chen',
    title: 'VP of Revenue Operations',
    company_name: 'Northwind Logistics',
    company_domain: 'northwindlogistics.com',
    linkedin_url: 'https://linkedin.com/in/sarahchen-example',
    source: 'apollo',
    source_id: 'apollo-fake-123',
    raw: {},
    email: 'sarah.chen@northwindlogistics.com',
    email_status: 'verified',
    email_verified_at: new Date().toISOString(),
    email_verification: null,
    status: 'active',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
}

function buildFakeClient(): ClientRow {
  return {
    id: 'fake-client-0000-0000-0000-00000000000',
    name: 'Vantage Robotics',
    status: 'active',
    settings: {},
    warmup_profile: 'standard',
    mailreach_enabled: false,
    reply_mode: 'human_approve',
    email_template_id: null,
    followup_delays_days: [3, 7],
    default_locale: 'en',
    domain: 'vantagerobotics.com',
    logo_url: null,
    phone: '+1 415 555 0182',
    address: '548 Market St, San Francisco, CA',
    signature_name: 'Jordan Lee',
    signature_title: 'Head of Partnerships',
    company_info:
      'Vantage Robotics builds AI-powered dispatch software for regional freight and logistics companies. ' +
      'We integrate directly with existing TMS platforms and typically go live in under two weeks.',
    timezone: 'America/Los_Angeles',
    default_discover_time: '09:00',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
}

// Ordered worst-to-best on purpose, matching DOSSIER_KIND_PRIORITY's sort in
// write.ts — this function's output order is irrelevant, buildPrompt() re-sorts it,
// but writing it "as discovered" here is the more realistic stand-in for what the
// research agent would actually hand off.
function buildFakeKnowledge(): KnowledgeRow[] {
  const base = {
    client_id: 'fake-client-0000-0000-0000-00000000000',
    case_id: 'fake-case-0000-0000-0000-000000000000',
    created_by: 'agent' as const,
    created_at: new Date().toISOString(),
    lead_id: null,
    event_date: null,
  }
  return [
    {
      id: 'fake-knowledge-company',
      ...base,
      kind: 'company',
      content: 'Northwind Logistics is a mid-size freight brokerage based in Columbus, Ohio, with roughly 140 employees.',
      source_url: 'https://northwindlogistics.com/about',
      citation: 'Company about page',
    },
    {
      id: 'fake-knowledge-person',
      ...base,
      kind: 'person',
      content: 'Sarah Chen joined Northwind Logistics as VP of Revenue Operations in January 2026, after leading ops at a smaller regional carrier.',
      source_url: 'https://linkedin.com/in/sarahchen-example',
      citation: 'LinkedIn profile',
    },
    {
      id: 'fake-knowledge-news',
      ...base,
      kind: 'news',
      content: 'Northwind Logistics announced a $14M Series B in June 2026 to expand its Midwest trucking routes.',
      source_url: 'https://example.com/press/northwind-series-b',
      citation: 'Press release, June 2026',
    },
    {
      id: 'fake-knowledge-pain-point',
      ...base,
      kind: 'pain_point',
      content:
        "Northwind Logistics' dispatch team still assigns loads manually in a shared spreadsheet — a listing for " +
        '"Dispatch Coordinator" on their careers page lists "manual load assignment via Excel" as a core responsibility.',
      source_url: 'https://northwindlogistics.com/careers/dispatch-coordinator',
      citation: 'Careers page job listing',
    },
  ]
}

function buildFakeInput(): RunWriteInput {
  return {
    clientId: 'fake-client-0000-0000-0000-00000000000',
    campaignId: 'fake-campaign-0000-0000-0000-0000000000',
    caseId: 'fake-case-0000-0000-0000-000000000000',
    replyMode: 'human_approve',
    valueProp: 'AI dispatch software that assigns loads automatically and cuts manual routing time by 80%.',
    bookingLink: 'https://cal.com/vantagerobotics/intro',
    mailboxIds: [],
    companyName: 'Northwind Logistics',
    signatureName: null,
    signatureTitle: null,
    signaturePhone: null,
    signatureAddress: null,
    campaignEmailTemplateId: null,
  }
}

interface AppDeps {
  generateJson: typeof import('../src/lib/llm/client').generateJson
  draftSchema: typeof import('../src/lib/pipeline/draft-schema').draftSchema
  buildSystemPrompt: typeof import('../src/lib/pipeline/write').buildSystemPrompt
  buildPrompt: typeof import('../src/lib/pipeline/write').buildPrompt
  EMAIL_WRITER_MODEL_ID: string
  MAX_OUTPUT_TOKENS: number
  appendSignatureBlock: typeof import('../src/lib/pipeline/signature').appendSignatureBlock
}

async function loadAppDeps(): Promise<AppDeps> {
  const [writeMod, llmMod, schemaMod, signatureMod] = await Promise.all([
    import('../src/lib/pipeline/write'),
    import('../src/lib/llm/client'),
    import('../src/lib/pipeline/draft-schema'),
    import('../src/lib/pipeline/signature'),
  ])
  return {
    generateJson: llmMod.generateJson,
    draftSchema: schemaMod.draftSchema,
    buildSystemPrompt: writeMod.buildSystemPrompt,
    buildPrompt: writeMod.buildPrompt,
    EMAIL_WRITER_MODEL_ID: writeMod.EMAIL_WRITER_MODEL_ID,
    MAX_OUTPUT_TOKENS: writeMod.MAX_OUTPUT_TOKENS,
    appendSignatureBlock: signatureMod.appendSignatureBlock,
  }
}

// Same heuristic scan regenerate-sample-emails.ts uses — a fast visual flag in the
// output, not a substitute for reading it.
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

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  loadEnv()
  const deps = await loadAppDeps()

  const lead = buildFakeLead()
  const client = buildFakeClient()
  const knowledge = buildFakeKnowledge()
  const input = buildFakeInput()

  const systemPrompt = deps.buildSystemPrompt(TEMPLATE_TEXT_BY_NAME[args.template])
  const userPrompt = deps.buildPrompt(input, lead, knowledge, client)

  console.log(`\n${'='.repeat(72)}`)
  console.log(`FAKE SCENARIO — template: ${args.template}`)
  console.log('='.repeat(72))
  console.log('\n--- SYSTEM PROMPT (buildSystemPrompt output) ---\n')
  console.log(systemPrompt)
  console.log('\n--- USER PROMPT (buildPrompt output) ---\n')
  console.log(userPrompt)

  const draft = await deps.generateJson(
    { clientId: input.clientId, caseId: input.caseId, actor: ACTOR },
    {
      instructions: systemPrompt,
      prompt: userPrompt,
      schema: deps.draftSchema,
      maxOutputTokens: deps.MAX_OUTPUT_TOKENS,
      modelId: deps.EMAIL_WRITER_MODEL_ID,
      // Matches write.ts's real processLead() thinking level exactly, so this
      // output stays representative of what the live pipeline actually generates.
      thinkingLevel: 'medium',
    },
  )

  const signedBody = deps.appendSignatureBlock(draft.body, {
    companyName: client.name,
    signatureName: client.signature_name,
    signatureTitle: client.signature_title,
    phone: client.phone,
    address: client.address,
    domain: client.domain,
  })

  console.log('\n--- MODEL OUTPUT (raw, pre-signature) ---\n')
  console.log(`Subject: ${draft.subject}`)
  console.log(draft.body)
  console.log(`\n(body: ${countWords(draft.body)} words)`)

  console.log('\n--- FINAL EMAIL (with signature block, exactly what write.ts would send) ---\n')
  console.log(`Subject: ${draft.subject}`)
  console.log(signedBody)

  const tells = scanForTells(`${draft.subject}\n${draft.body}`)
  console.log(`\nTells found: ${tells.length > 0 ? tells.join(', ') : 'none'}`)
  console.log(`${'='.repeat(72)}\n`)
}

main().catch((error) => {
  if (error instanceof AppError) {
    console.error(`[${error.code}] ${error.message}`, error.context)
  } else {
    console.error(error)
  }
  process.exitCode = 1
})
