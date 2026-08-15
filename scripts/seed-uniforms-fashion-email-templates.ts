// One-off seed: creates the 6 campaign-specific email templates Uniforms
// Fashion's operator supplied verbatim (2026-08-15 handoff — see
// .claude/roadmap.md) and assigns each to its matching live campaign via the
// new campaigns.email_template_id override (migration 0046). Healthcare
// Sector ("Saglik Sektoru") and Schools ("Okullar") are deliberately left
// untouched — no matching sample exists for either yet, so they keep
// inheriting the client's current default template, same as every other
// campaign before this change.
//
// Each template's sign-off ("Kind regards, Cihat...") is stripped from the
// stored text — a signature block is appended separately in code
// (write.ts's appendSignatureBlock), and leaving a second sign-off in the
// reference template risked the model echoing it verbatim alongside the
// real one. The Defence Prime Contractor sample's blank capacity bullet
// ("Capacity: […] suits / […] jackets per month") is dropped entirely, per
// operator instruction — no real figure was supplied and one is not
// invented. Border/Transport/Hospitality each carry more than one raw
// sample, separated by a "---" line, per operator instruction
// (buildSystemPrompt's TEMPLATE_USAGE_INSTRUCTION tells the model to pick
// whichever one matches the recipient's actual sub-vertical).
//
// Defaults to a dry run — prints what it would create/assign but writes
// nothing. Pass --apply to persist. Safe to re-run: template creation is
// idempotent on name (a second run finds the existing row and reuses it
// instead of erroring), and campaign assignment is a plain overwrite.
//
//   pnpm tsx scripts/seed-uniforms-fashion-email-templates.ts            # dry run
//   pnpm tsx scripts/seed-uniforms-fashion-email-templates.ts --apply    # persists
//
// Requires migration 0046_email_templates_rename_and_campaign_override.sql
// to already be applied — this script does not run migrations.
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import type { Database } from '../src/types/database'
import { AppError } from '../src/lib/errors/app-error'

const UNIFORMS_FASHION_CLIENT_ID = 'd99edf8f-b185-47b2-9615-1f6e43853001'

const envSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
})

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

interface TemplateSeed {
  name: string
  templateText: string
  // Live campaign id this template is assigned to (see the operator's
  // 2026-08-15 mapping in .claude/roadmap.md). Turkish names in comments are
  // the live campaigns.name values, for anyone cross-checking against the DB.
  campaignId: string
  campaignLabel: string
}

const TEMPLATES: readonly TemplateSeed[] = [
  {
    name: 'Uniforms Fashion — Public Safety',
    campaignId: 'd34557fb-3ff1-4d39-a8f5-76d0a8bf50a5',
    campaignLabel: 'Kamu Guvenligi (Public Safety Agencies)',
    templateText:
      'Dear Sir/Madam,\n' +
      'With 30 years of manufacturing experience, we design and produce uniforms for police, municipal units, ' +
      'correctional facilities and private security companies. All production is completed end to end in our own ' +
      'facilities in Istanbul.\n' +
      'We can prepare a sample in line with your technical specification free of charge.\n' +
      'Could you kindly advise the procedure for supplier registration and sample submission?',
  },
  {
    name: 'Uniforms Fashion — Border & Aviation Security',
    campaignId: '23071da8-1a0e-4b80-a199-0c3e7d3c154f',
    campaignLabel: 'Sinir ve Transit Guvenligi (Border & Transit Security)',
    templateText:
      'Dear Sir/Madam,\n' +
      'Customs and border officers spend most of the year outdoors, at crossings, in changing weather. Our ' +
      'uniforms are engineered for exactly those conditions.\n' +
      'With 30 years of manufacturing experience, from our own facilities in Istanbul:\n' +
      '- Layered system: parka, cold-weather jacket, fleece mid-layer, summer set\n' +
      '- Waterproof and windproof outer shell, reflective visibility striping\n' +
      '- Service emblems, rank insignia and back lettering applied in house\n' +
      '- Cargo trousers, shirts, caps, belts and accessories from one source\n' +
      'We have supplied uniforms for a revenue and customs authority in East Africa and understand the ' +
      'durability standards this service requires.\n' +
      'We can prepare a sample to your technical specification free of charge. Could you kindly advise the ' +
      'procedure for supplier registration and sample evaluation?\n' +
      '\n---\n\n' +
      'Dear Sir/Madam,\n' +
      'Airport security officers work long shifts that demand constant movement while remaining in full public ' +
      'view. The uniform has to be comfortable and representative at the same time.\n' +
      'We manufacture uniforms for the aviation sector in our own facilities in Istanbul:\n' +
      '- Breathable, crease-resistant fabrics that hold their shape through a 12-hour shift\n' +
      '- Clear colour coding and reflective detailing for recognition across a terminal\n' +
      '- Cut compatible with vests, radios and ID card holders\n' +
      '- Shirts, ties, suits, jackets, cargo trousers and caps from one source\n' +
      'We also have experience with ground handling and airline cabin crew uniforms.\n' +
      'We can prepare a sample to your specification free of charge. Could you kindly advise the procedure for ' +
      'supplier registration?',
  },
  {
    name: 'Uniforms Fashion — Defense Prime Contractor',
    campaignId: '2f871cfb-90f4-461c-a534-87cf7f5abb30',
    campaignLabel: 'Savunma ve Askeriye (Defense & Military)',
    templateText:
      'Dear [Name],\n' +
      'On defence and security uniform contracts, the real risk is not price but delivery. A delay means ' +
      'penalties, and penalties mean losing the next tender.\n' +
      'Uniforms Fashion has manufactured in our own facilities in Istanbul for 30 years, providing subcontract ' +
      'capacity to companies holding these contracts:\n' +
      '- Production to your specification, patterns and fabric — CMT or full package\n' +
      '- Approved sample sewn in 3 working days, bulk production starting within 10\n' +
      '- Embroidery, printing, rank insignia and badges applied in house — no outside workshops\n' +
      '- We sign NDAs and we do not bid against you on the same tenders\n' +
      'That last point matters: we are not your competitor, we are your capacity.\n' +
      'Send your technical file for any current or upcoming contract and we will return unit pricing and a ' +
      'delivery schedule within 24 hours.',
  },
  {
    name: 'Uniforms Fashion — Transport & Ground Ops',
    campaignId: 'dee813ad-e921-4fb0-951b-b617e2c1afdc',
    campaignLabel: 'Ozel Sektor — Ulasim (Private Sector — Transport & Utilities)',
    templateText:
      'Dear [Name],\n' +
      'In most terminals, passenger services, ramp, baggage, cleaning and technical teams are dressed by ' +
      'different suppliers. The result is a fragmented look under one roof.\n' +
      'We produce every category to a single visual standard, in our own facilities:\n' +
      '- Passenger services and check-in: corporate suits, shirts, scarves\n' +
      '- Ramp and baggage: high-visibility coveralls and jackets to EN ISO 20471 level\n' +
      '- Technical and cleaning teams: durable fabrics suited to industrial laundry\n' +
      '- Department colour coding for instant recognition across the terminal\n' +
      'Even where your teams sit with different service providers, the standard can be managed from one ' +
      'source. May we prepare a concept study free of charge?\n' +
      '\n---\n\n' +
      'Dear [Name],\n' +
      'In rail and public transport operations, the real challenge is not the first order but continuity: ' +
      'dressing every new joiner in exactly the same colour and cut, month after month.\n' +
      'From our own facilities in Istanbul:\n' +
      '- Drivers and train operators: cut for seated work, breathable fabrics\n' +
      '- Train and station staff: corporate suits, shirts, waistcoats, jackets\n' +
      '- Track maintenance and field teams: high-visibility clothing to EN ISO 20471 level\n' +
      '- Pattern and fabric archive plus held stock for fast top-up deliveries\n' +
      '- Competitive unit pricing at volume, supported by wash-durability test reports\n' +
      'Send us your headcount and item list and we will prepare unit pricing and an annual supply plan.\n' +
      '\n---\n\n' +
      'Dear [Name],\n' +
      'Uniforms Fashion has designed and manufactured uniforms for 30 years, in our own facilities in ' +
      'Istanbul.\n' +
      'For airlines we cover every category from one source: cabin crew, flight deck, ground staff and ramp ' +
      'teams. Design, patterns, fabric sourcing, embroidery and shipping are all handled in house — no ' +
      'intermediaries, which means direct control over price and lead time.\n' +
      'We also maintain a pattern and fabric archive, so repeat and top-up orders years later come back in ' +
      'exactly the same colour and cut.\n' +
      "Could we arrange a 15-minute call to discuss [Airline]'s uniform requirements for the coming period?",
  },
  {
    name: 'Uniforms Fashion — Hospitality & Travel',
    campaignId: '859462fc-cbed-4b6d-9e43-66d8d889268b',
    campaignLabel: 'Otel ve Turizm (Hospitality & Tourism)',
    templateText:
      'Dear [Name],\n' +
      "A guest's first impression of [Hotel Name] begins with how your team looks. That is exactly what we " +
      'design.\n' +
      'We create and manufacture hotel and resort uniforms in our own facilities in Istanbul — covering every ' +
      'department from one source: front office, housekeeping, service, kitchen, spa, maintenance and ' +
      'security.\n' +
      '- Designed around your brand colours and concept\n' +
      '- Fabrics tested for industrial laundry, with colour fastness reports\n' +
      '- Pattern and fabric archive: identical repeat orders two years later\n' +
      '- Fast top-up orders for new staff\n' +
      "If you wish, we will prepare 2-3 design visuals in your hotel's colours free of charge; if you like " +
      'them, we will sew a sample.\n' +
      '\n---\n\n' +
      'Hello,\n' +
      'We produce corporate clothing for travel agencies, tour operators and cruise companies — guides and ' +
      'transfer teams, office staff, welcome desk and deck crew.\n' +
      'Designed in your brand colours, manufactured in house, logo embroidery included. Send us your ' +
      'headcount and we will return a concept visual and pricing.',
  },
  {
    name: 'Uniforms Fashion — Cargo & Courier',
    campaignId: '28238bad-898d-48e0-bce6-4543f9200193',
    campaignLabel: 'Perakende ve Hizmet (Retail & Service)',
    templateText:
      'Dear [Name],\n' +
      'With courier clothing, the real cost is not the unit price but how many times a year it has to be ' +
      'replaced. Weak fabric lasts six months; the right fabric lasts two seasons.\n' +
      'Uniforms Fashion has manufactured in our own facilities in Istanbul for 30 years:\n' +
      '- Couriers and motorcycle riders: waterproof jackets, windproof outer layers, reflective visibility ' +
      'striping\n' +
      '- Delivery and warehouse teams: cut for lifting, pockets sized for handheld scanners\n' +
      '- Your branding printed and embroidered — wash-fast, supported by test reports\n' +
      '- Size sets held in stock for fast top-up shipments as new staff join\n' +
      'In operations with high staff turnover, that last point is where the real difference shows.\n' +
      'If you share your current annual uniform budget and item list, we will prepare a comparative ' +
      'quotation. Would you have time for a short call?',
  },
]

async function upsertTemplateByName(
  supabase: SupabaseClient<Database>,
  seed: TemplateSeed,
  apply: boolean,
): Promise<string | null> {
  const { data: existing, error: findError } = await supabase
    .from('email_templates')
    .select('id')
    .eq('name', seed.name)
    .maybeSingle()
  if (findError) {
    throw new AppError('DB_ERROR', 'Failed to look up existing email template', { name: seed.name, cause: findError.message })
  }
  if (existing) {
    console.log(`  [exists] "${seed.name}" -> ${existing.id} (not re-created)`)
    return existing.id
  }
  if (!apply) {
    console.log(`  [would create] "${seed.name}" (${seed.templateText.length} chars)`)
    return null
  }
  const { data: created, error: insertError } = await supabase
    .from('email_templates')
    .insert({ name: seed.name, template_text: seed.templateText })
    .select('id')
    .single()
  if (insertError || !created) {
    throw new AppError('DB_ERROR', 'Failed to create email template', { name: seed.name, cause: insertError?.message })
  }
  console.log(`  [created] "${seed.name}" -> ${created.id}`)
  return created.id
}

async function assignCampaignTemplate(
  supabase: SupabaseClient<Database>,
  seed: TemplateSeed,
  templateId: string | null,
  apply: boolean,
): Promise<void> {
  if (!apply || !templateId) {
    console.log(`  [would assign] ${seed.campaignLabel} -> "${seed.name}"`)
    return
  }
  const { error } = await supabase.from('campaigns').update({ email_template_id: templateId }).eq('id', seed.campaignId)
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to assign campaign email template', {
      campaignId: seed.campaignId,
      templateId,
      cause: error.message,
    })
  }
  console.log(`  [assigned] ${seed.campaignLabel} -> "${seed.name}"`)
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply')
  const env = loadEnv()
  const supabase = createClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  })

  const { data: client, error: clientError } = await supabase
    .from('clients')
    .select('id, name')
    .eq('id', UNIFORMS_FASHION_CLIENT_ID)
    .maybeSingle()
  if (clientError) {
    throw new AppError('DB_ERROR', 'Failed to load Uniforms Fashion client row', { cause: clientError.message })
  }
  if (!client || client.name !== 'Uniforms Fashion') {
    throw new AppError('INVARIANT_VIOLATION', 'Client id no longer resolves to Uniforms Fashion — refusing to seed', {
      found: client,
    })
  }

  console.log(`Mode: ${apply ? 'APPLY (writing to DB)' : 'DRY RUN (preview only — pass --apply to write)'}\n`)

  for (const seed of TEMPLATES) {
    console.log(`${seed.name}  ->  ${seed.campaignLabel}`)
    const templateId = await upsertTemplateByName(supabase, seed, apply)
    await assignCampaignTemplate(supabase, seed, templateId, apply)
  }

  console.log(
    '\nHealthcare Sector ("Saglik Sektoru") and Schools ("Okullar") are intentionally left untouched — no ' +
      'matching sample yet.',
  )
}

main().catch((error) => {
  if (error instanceof AppError) {
    console.error(`[${error.code}] ${error.message}`, error.context)
  } else {
    console.error(error)
  }
  process.exitCode = 1
})
