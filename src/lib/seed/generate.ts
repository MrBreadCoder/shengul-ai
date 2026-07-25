import type { Database, Json } from '@/types/database'
import { AppError } from '@/lib/errors/app-error'
import { createRng, type Rng } from '@/lib/seed/random'
import {
  CAMPAIGN_FIXTURES,
  CLIENT_FIXTURES,
  CLOSING_TEMPLATES,
  COMPANY_FIXTURES,
  FIRST_NAMES,
  FOLLOWUP_BODIES,
  FOLLOWUP_SUBJECT_PREFIX,
  KNOWLEDGE_REQUEST_ANSWERS,
  KNOWLEDGE_REQUEST_QUESTIONS,
  KNOWLEDGE_TEMPLATES,
  LAST_NAMES,
  MAILBOX_FIXTURES,
  OPENING_TEMPLATES,
  PAIN_POINTS,
  PITCH_TEMPLATES,
  REPLY_FIXTURES,
  REPLY_OUTBOUND_TEMPLATES,
  SIGNALS,
  SUBJECT_TEMPLATES,
  TITLES,
  type ReplyIntent,
  type SeedCompanyFixture,
} from '@/lib/seed/fixtures'

type Tables = Database['public']['Tables']
type Enums = Database['public']['Enums']
type CaseStatus = Enums['case_status']

/** Every seeded row carries an explicit id so foreign keys can be wired before insert. */
type WithId<T> = T & { id: string }

export type SeedClient = WithId<Tables['clients']['Insert']>
export type SeedCampaign = WithId<Tables['campaigns']['Insert']>
export type SeedMailbox = WithId<Tables['mailboxes']['Insert']>
export type SeedCase = WithId<Tables['cases']['Insert']>
export type SeedLead = WithId<Tables['leads']['Insert']>
export type SeedCaseKnowledge = WithId<Tables['case_knowledge']['Insert']>
export type SeedEmail = WithId<Tables['emails']['Insert']>
export type SeedSequence = WithId<Tables['sequences']['Insert']>
export type SeedKnowledgeRequest = WithId<Tables['knowledge_requests']['Insert']>
export type SeedSuppression = WithId<Tables['suppressions']['Insert']>
export type SeedEvent = WithId<Tables['events']['Insert']>

export interface SeedDataset {
  clients: SeedClient[]
  campaigns: SeedCampaign[]
  mailboxes: SeedMailbox[]
  cases: SeedCase[]
  leads: SeedLead[]
  caseKnowledge: SeedCaseKnowledge[]
  emails: SeedEmail[]
  sequences: SeedSequence[]
  knowledgeRequests: SeedKnowledgeRequest[]
  suppressions: SeedSuppression[]
  events: SeedEvent[]
  /** The client the `client`-role demo user is scoped to. */
  demoClientId: string
}

export interface GenerateSeedOptions {
  seed: number
  /** Anchor date; history spans the HISTORY_DAYS ending on this day (UTC). */
  today: Date
  /** auth.users id used for `knowledge_requests.answered_by` on answered rows. */
  operatorUserId: string
}

const MS_PER_DAY = 86_400_000
const HISTORY_DAYS = 60
const LAST_DAY_INDEX = HISTORY_DAYS - 1
/** Follow-up cadence in calendar days after the first touch, matching a 3-step sequence. */
const FOLLOWUP_OFFSETS = [3, 7] as const
const MAX_SEQUENCE_STEP = FOLLOWUP_OFFSETS.length
/** Sending window in UTC hours — keeps sent_at inside plausible business hours. */
const SEND_HOUR_RANGE = [8, 16] as const
/** Caps on the rows that surface in /inbox, so the page stays readable. */
const MAX_FIRST_TOUCH_DRAFTS = 4
const MAX_REPLY_DRAFTS = 4
const MAX_OPEN_KNOWLEDGE_REQUESTS = 5
const MAX_CLOSED_KNOWLEDGE_REQUESTS = 5

interface CasePlan {
  readonly count: number
  /** Inclusive range of days before `today` that discovery happened. */
  readonly daysAgo: readonly [number, number]
  readonly knowledge: 'none' | 'partial' | 'full'
  readonly hasEmails: boolean
  /** Reply the responder lead sends, if any. */
  readonly replyIntent: ReplyIntent | null
  /** Share of cases in this bucket where the reply actually happens. */
  readonly replyProbability: number
  readonly sequenceState: Enums['sequence_state'] | null
}

// Counts are exact (not weighted) so every CRM column is guaranteed populated,
// and maturity windows are ordered: a `won` case must be old enough to have run
// a full sequence, a `new` case must be too young to have been contacted.
const CASE_PLANS: Readonly<Record<CaseStatus, CasePlan>> = {
  new: { count: 14, daysAgo: [0, 2], knowledge: 'none', hasEmails: false, replyIntent: null, replyProbability: 0, sequenceState: null },
  researching: { count: 6, daysAgo: [0, 3], knowledge: 'partial', hasEmails: false, replyIntent: null, replyProbability: 0, sequenceState: null },
  ready: { count: 12, daysAgo: [1, 6], knowledge: 'full', hasEmails: false, replyIntent: null, replyProbability: 0, sequenceState: null },
  contacted: { count: 52, daysAgo: [3, 45], knowledge: 'full', hasEmails: true, replyIntent: null, replyProbability: 0, sequenceState: 'active' },
  in_conversation: { count: 26, daysAgo: [6, 50], knowledge: 'full', hasEmails: true, replyIntent: 'interested', replyProbability: 1, sequenceState: 'completed' },
  hot_handoff: { count: 11, daysAgo: [8, 52], knowledge: 'full', hasEmails: true, replyIntent: 'price', replyProbability: 1, sequenceState: 'completed' },
  won: { count: 9, daysAgo: [20, 55], knowledge: 'full', hasEmails: true, replyIntent: 'interested', replyProbability: 1, sequenceState: 'completed' },
  lost: { count: 14, daysAgo: [15, 55], knowledge: 'full', hasEmails: true, replyIntent: 'not_now', replyProbability: 1, sequenceState: 'stopped' },
  // Half of `dead` is an opt-out reply, half is a hard bounce with no reply.
  dead: { count: 14, daysAgo: [12, 55], knowledge: 'full', hasEmails: true, replyIntent: 'opt_out', replyProbability: 0.5, sequenceState: 'stopped' },
}

const CASE_STATUS_ORDER: readonly CaseStatus[] = [
  'new', 'researching', 'ready', 'contacted', 'in_conversation', 'hot_handoff', 'won', 'lost', 'dead',
]

/** Leads per case: most companies yield 2-3 usable contacts. */
const LEADS_PER_CASE: readonly (readonly [number, number])[] = [[1, 30], [2, 35], [3, 25], [4, 10]]

/** Outbound delivery outcomes for a healthy sender. Drives the bounce/failure rates on /analytics. */
const SEND_OUTCOMES: readonly (readonly [Enums['email_status'], number])[] = [
  ['delivered', 70], ['sent', 27], ['bounced', 2], ['failed', 1],
]

const EMAIL_STATUS_FOR_UNCONTACTED: readonly (readonly [Enums['lead_email_status'], number])[] = [
  ['unverified', 55], ['verified', 25], ['risky', 10], ['not_found', 7], ['invalid', 3],
]

const EMAIL_STATUS_FOR_SECONDARY: readonly (readonly [Enums['lead_email_status'], number])[] = [
  ['verified', 45], ['unverified', 20], ['risky', 15], ['not_found', 12], ['invalid', 8],
]

const DAILY_CRON_EVENTS: readonly string[] = [
  'pipeline.discover_fanout.completed',
  'pipeline.research_fanout.completed',
  'pipeline.write_fanout.completed',
  'inbound.poll_fanout.completed',
  'mailbox.daily_reset.completed',
  'pipeline.stuck_sweep.completed',
]

// ---------- date helpers ----------

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
}

function dayDate(windowStart: Date, dayIndex: number): Date {
  return new Date(windowStart.getTime() + dayIndex * MS_PER_DAY)
}

function isWeekend(windowStart: Date, dayIndex: number): boolean {
  const weekday = dayDate(windowStart, dayIndex).getUTCDay()
  return weekday === 0 || weekday === 6
}

/**
 * First non-weekend index at or after `dayIndex`, or null if that would run past
 * the end of the history window. The pipeline sends on business days only, which
 * is what gives the /analytics sparklines their weekly shape.
 */
function nextBusinessDay(windowStart: Date, dayIndex: number): number | null {
  for (let index = dayIndex; index <= LAST_DAY_INDEX; index++) {
    if (!isWeekend(windowStart, index)) return index
  }
  return null
}

function isoAt(windowStart: Date, dayIndex: number, hour: number, minute: number): string {
  const date = dayDate(windowStart, dayIndex)
  date.setUTCHours(hour, minute, 0, 0)
  return date.toISOString()
}

function businessHourIso(rng: Rng, windowStart: Date, dayIndex: number): string {
  return isoAt(windowStart, dayIndex, rng.int(SEND_HOUR_RANGE[0], SEND_HOUR_RANGE[1]), rng.int(0, 59))
}

// ---------- template helpers ----------

function fill(template: string, vars: Readonly<Record<string, string>>): string {
  return template.replace(/\{(\w+)\}/g, (match: string, key: string) => vars[key] ?? match);
}

function slugifyName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

// ---------- accumulator ----------

interface Accumulator {
  readonly rng: Rng
  readonly windowStart: Date
  readonly operatorUserId: string
  readonly clients: SeedClient[]
  readonly campaigns: SeedCampaign[]
  readonly mailboxes: SeedMailbox[]
  readonly cases: SeedCase[]
  readonly leads: SeedLead[]
  readonly caseKnowledge: SeedCaseKnowledge[]
  readonly emails: SeedEmail[]
  readonly sequences: SeedSequence[]
  readonly knowledgeRequests: SeedKnowledgeRequest[]
  readonly suppressions: SeedSuppression[]
  readonly events: SeedEvent[]
  /** Guards the `suppressions_client_email_uniq` index. */
  readonly suppressedKeys: Set<string>
  readonly counters: { firstTouchDrafts: number; replyDrafts: number; openRequests: number; closedRequests: number }
}

function addEvent(
  acc: Accumulator,
  input: { clientId: string | null; caseId?: string | null; actor: string; type: string; createdAt: string; payload?: Record<string, Json> },
): void {
  acc.events.push({
    id: acc.rng.uuid(),
    client_id: input.clientId,
    case_id: input.caseId ?? null,
    actor: input.actor,
    type: input.type,
    payload: input.payload ?? {},
    created_at: input.createdAt,
  })
}

function addSuppression(
  acc: Accumulator,
  input: { clientId: string; email: string; reason: Enums['suppression_reason']; createdAt: string },
): void {
  const key = `${input.clientId}:${input.email}`
  if (acc.suppressedKeys.has(key)) return
  acc.suppressedKeys.add(key)
  acc.suppressions.push({
    id: acc.rng.uuid(),
    client_id: input.clientId,
    email: input.email,
    reason: input.reason,
    created_at: input.createdAt,
  })
}

// ---------- top level ----------

export function generateSeedData({ seed, today, operatorUserId }: GenerateSeedOptions): SeedDataset {
  const rng = createRng(seed)
  // Window is [windowStart, today], inclusive of both, LAST_DAY_INDEX == today.
  const windowStart = new Date(startOfUtcDay(today).getTime() - LAST_DAY_INDEX * MS_PER_DAY)

  const acc: Accumulator = {
    rng,
    windowStart,
    operatorUserId,
    clients: [],
    campaigns: [],
    mailboxes: [],
    cases: [],
    leads: [],
    caseKnowledge: [],
    emails: [],
    sequences: [],
    knowledgeRequests: [],
    suppressions: [],
    events: [],
    suppressedKeys: new Set<string>(),
    counters: { firstTouchDrafts: 0, replyDrafts: 0, openRequests: 0, closedRequests: 0 },
  }

  buildClients(acc)
  buildMailboxes(acc)
  buildCampaigns(acc)
  buildCases(acc)
  buildCronEvents(acc)

  const demoClientId = acc.clients[0]?.id
  if (!demoClientId) {
    throw new AppError('INVARIANT_VIOLATION', 'Seed generated no clients', {})
  }

  return {
    clients: acc.clients,
    campaigns: acc.campaigns,
    mailboxes: acc.mailboxes,
    cases: acc.cases,
    leads: acc.leads,
    caseKnowledge: acc.caseKnowledge,
    emails: acc.emails,
    sequences: acc.sequences,
    knowledgeRequests: acc.knowledgeRequests,
    suppressions: acc.suppressions,
    events: acc.events,
    demoClientId,
  }
}

// ---------- clients / mailboxes / campaigns ----------

function buildClients(acc: Accumulator): void {
  for (const fixture of CLIENT_FIXTURES) {
    const createdAt = isoAt(acc.windowStart, 0, 9, 0)
    acc.clients.push({
      id: acc.rng.uuid(),
      name: fixture.name,
      status: fixture.status,
      settings: { valueProp: fixture.valueProp, bookingLink: fixture.bookingLink },
      created_at: createdAt,
      updated_at: createdAt,
    })
  }
}

function buildMailboxes(acc: Accumulator): void {
  for (const fixture of MAILBOX_FIXTURES) {
    const client = acc.clients[fixture.clientIndex]
    if (!client) continue
    const createdAt = isoAt(acc.windowStart, 0, 10, acc.rng.int(0, 59))
    acc.mailboxes.push({
      id: acc.rng.uuid(),
      client_id: client.id,
      provider: fixture.provider,
      email_address: fixture.emailAddress,
      display_name: fixture.displayName,
      // Placeholder credentials: this mailbox can never actually send. Any real
      // send or "test email" from /settings will fail with a provider auth error.
      oauth: {
        seeded: true,
        access_token: 'seed-placeholder-access-token',
        refresh_token: 'seed-placeholder-refresh-token',
        expires_at: new Date(acc.windowStart.getTime()).toISOString(),
      },
      daily_cap: fixture.dailyCap,
      sent_today: fixture.sentToday,
      warmup_profile: fixture.health === 'ok' ? 'none' : 'standard',
      warmup_started_at: fixture.health === 'ok' ? null : createdAt,
      health: fixture.health,
      inbound_cursor: fixture.provider === 'gmail' ? 'seed-history-id-104822' : 'seed-delta-token',
      created_at: createdAt,
      updated_at: createdAt,
    })
    addEvent(acc, {
      clientId: client.id,
      actor: 'operator',
      type: 'mailbox.connected',
      createdAt,
      payload: { provider: fixture.provider, emailAddress: fixture.emailAddress },
    })
  }
}

function buildCampaigns(acc: Accumulator): void {
  for (const fixture of CAMPAIGN_FIXTURES) {
    const client = acc.clients[fixture.clientIndex]
    const clientFixture = CLIENT_FIXTURES[fixture.clientIndex]
    if (!client || !clientFixture) continue
    const createdAt = isoAt(acc.windowStart, acc.rng.int(0, 2), 11, acc.rng.int(0, 59))
    acc.campaigns.push({
      id: acc.rng.uuid(),
      client_id: client.id,
      name: fixture.name,
      status: fixture.status,
      icp: {
        titles: [...fixture.icp.titles],
        employeeRange: [...fixture.icp.employeeRange],
        industries: [...fixture.icp.industries],
        geos: [...fixture.icp.geos],
      },
      value_prop: clientFixture.valueProp,
      booking_link: clientFixture.bookingLink,
      reply_mode: fixture.replyMode,
      price_handoff_mode: fixture.priceHandoffMode,
      mailbox_ids: acc.mailboxes.filter((m) => m.client_id === client.id).map((m) => m.id),
      daily_target: fixture.dailyTarget,
      created_at: createdAt,
      updated_at: createdAt,
    })
    addEvent(acc, {
      clientId: client.id,
      actor: 'operator',
      type: 'campaign.created',
      createdAt,
      payload: { name: fixture.name, dailyTarget: fixture.dailyTarget },
    })
  }
}

// ---------- cases ----------

interface CampaignContext {
  readonly campaign: SeedCampaign
  readonly fixture: (typeof CAMPAIGN_FIXTURES)[number]
  /** Companies not yet used by this campaign — guards idx_cases_campaign_company_key. */
  readonly companyQueue: SeedCompanyFixture[]
  readonly mailboxes: SeedMailbox[]
  /** Monotonic per-campaign counter backing the unique (campaign_id, source_id) index. */
  sourceCounter: number
}

function buildCampaignContexts(acc: Accumulator): CampaignContext[] {
  return acc.campaigns.map((campaign, index) => {
    const fixture = CAMPAIGN_FIXTURES[index]
    if (!fixture) throw new AppError('INVARIANT_VIOLATION', 'Campaign fixture missing', { index })
    return {
      campaign,
      fixture,
      companyQueue: acc.rng.shuffle(COMPANY_FIXTURES),
      // A blocked mailbox never sends, so it is excluded from the send pool.
      mailboxes: acc.mailboxes.filter((m) => m.client_id === campaign.client_id && m.health !== 'blocked'),
      sourceCounter: 0,
    }
  })
}

function buildCases(acc: Accumulator): void {
  const contexts = buildCampaignContexts(acc)
  if (contexts.length === 0) return

  // Round-robin across campaigns so every campaign row on /analytics has data,
  // and interleave statuses so maturity is not correlated with campaign.
  const queue: CaseStatus[] = []
  for (const status of CASE_STATUS_ORDER) {
    for (let i = 0; i < CASE_PLANS[status].count; i++) queue.push(status)
  }

  acc.rng.shuffle(queue).forEach((status, index) => {
    const context = contexts[index % contexts.length]
    if (!context) return
    const company = context.companyQueue.pop()
    if (!company) return
    buildCase(acc, context, company, status)
  })
}

function buildCase(
  acc: Accumulator,
  context: CampaignContext,
  company: SeedCompanyFixture,
  status: CaseStatus,
): void {
  const plan = CASE_PLANS[status]
  const { rng, windowStart } = acc
  const discoveryDay = Math.max(0, LAST_DAY_INDEX - rng.int(plan.daysAgo[0], plan.daysAgo[1]))
  const discoveredAt = isoAt(windowStart, discoveryDay, rng.int(6, 9), rng.int(0, 59))
  const clientId = context.campaign.client_id

  const seedCase: SeedCase = {
    id: rng.uuid(),
    client_id: clientId,
    campaign_id: context.campaign.id,
    company_name: company.name,
    company_domain: company.domain,
    company_key: company.domain.toLowerCase(),
    status,
    summary: plan.knowledge === 'none'
      ? null
      : `${company.name} — ${company.industry} in ${company.city}, ~${company.employees} staff. ${
          rng.pick(PAIN_POINTS).replace(/^./, (c) => c.toUpperCase())
        }.`,
    created_at: discoveredAt,
    updated_at: discoveredAt,
  }
  acc.cases.push(seedCase)

  const leads = buildLeads(acc, context, seedCase, company, plan, discoveryDay)
  addEvent(acc, {
    clientId,
    caseId: seedCase.id,
    actor: 'pipeline',
    type: 'pipeline.lead_grouped',
    createdAt: discoveredAt,
    payload: { companyKey: seedCase.company_key, leadCount: leads.length },
  })

  const knowledgeDay = buildKnowledge(acc, seedCase, company, plan, discoveryDay)
  if (!plan.hasEmails) {
    seedCase.updated_at = isoAt(windowStart, knowledgeDay, rng.int(10, 17), rng.int(0, 59))
    return
  }
  buildOutreach(acc, context, seedCase, company, plan, knowledgeDay, leads)
}

// ---------- leads ----------

function buildLeads(
  acc: Accumulator,
  context: CampaignContext,
  seedCase: SeedCase,
  company: SeedCompanyFixture,
  plan: CasePlan,
  discoveryDay: number,
): SeedLead[] {
  const { rng } = acc
  const count = rng.weighted(LEADS_PER_CASE)
  const firstNames = rng.sample(FIRST_NAMES, count)
  const lastNames = rng.sample(LAST_NAMES, count)
  const titlePool = context.fixture.icp.titles.length > 0 ? context.fixture.icp.titles : TITLES
  const leads: SeedLead[] = []

  for (let i = 0; i < count; i++) {
    const firstName = firstNames[i] ?? rng.pick(FIRST_NAMES)
    const lastName = lastNames[i] ?? rng.pick(LAST_NAMES)
    const fullName = `${firstName} ${lastName}`
    const createdAt = isoAt(acc.windowStart, discoveryDay, rng.int(6, 9), rng.int(0, 59))
    // The first lead of a contactable case is always verified+active, so every
    // `contacted`-or-later case genuinely has someone the pipeline could email.
    const isPrimary = i === 0 && plan.hasEmails
    const emailStatus: Enums['lead_email_status'] = isPrimary
      ? 'verified'
      : rng.weighted(plan.hasEmails ? EMAIL_STATUS_FOR_SECONDARY : EMAIL_STATUS_FOR_UNCONTACTED)
    const isVerified = emailStatus === 'verified'
    context.sourceCounter += 1

    const lead: SeedLead = {
      id: rng.uuid(),
      client_id: seedCase.client_id,
      campaign_id: context.campaign.id,
      case_id: seedCase.id,
      full_name: fullName,
      title: rng.pick(titlePool),
      company_name: company.name,
      company_domain: company.domain,
      linkedin_url: `https://www.linkedin.test/in/${slugifyName(firstName)}-${slugifyName(lastName)}`,
      source: 'apollo',
      source_id: `apollo_${context.campaign.id.slice(0, 8)}_${context.sourceCounter}`,
      raw: {
        provider: 'apollo',
        organization: { name: company.name, primary_domain: company.domain, estimated_num_employees: company.employees, industry: company.industry },
        city: company.city,
        seniority: 'director',
      },
      email: `${slugifyName(firstName)}.${slugifyName(lastName)}@${company.domain}`,
      email_status: emailStatus,
      email_verified_at: isVerified ? createdAt : null,
      status: plan.knowledge === 'none' ? 'new' : isVerified ? 'active' : 'parked',
      created_at: createdAt,
      updated_at: createdAt,
    }
    leads.push(lead)
    acc.leads.push(lead)
    addEvent(acc, {
      clientId: seedCase.client_id,
      caseId: seedCase.id,
      actor: 'pipeline',
      type: 'lead.found',
      createdAt,
      payload: { fullName, emailStatus },
    })
  }
  return leads
}

// ---------- research ----------

/** Returns the day research finished (or the discovery day when nothing was researched). */
function buildKnowledge(
  acc: Accumulator,
  seedCase: SeedCase,
  company: SeedCompanyFixture,
  plan: CasePlan,
  discoveryDay: number,
): number {
  if (plan.knowledge === 'none') return discoveryDay
  const { rng } = acc
  const researchDay = Math.min(LAST_DAY_INDEX, discoveryDay + rng.int(0, 1))
  const entryCount = plan.knowledge === 'partial' ? rng.int(1, 2) : rng.int(3, 6)
  // 'answer' is excluded deliberately: those rows are written by the reply
  // pipeline from a human answer, not by the research agent.
  const kinds: readonly (keyof typeof KNOWLEDGE_TEMPLATES)[] = ['company', 'person', 'news', 'pain_point']
  const leadNames = acc.leads.filter((l) => l.case_id === seedCase.id)

  for (let i = 0; i < entryCount; i++) {
    const kind = i < kinds.length ? kinds[i]! : rng.pick(kinds)
    const lead = leadNames[i % Math.max(1, leadNames.length)]
    const vars: Record<string, string> = {
      company: company.name,
      industry: company.industry,
      city: company.city,
      employees: String(company.employees),
      fullName: lead?.full_name ?? 'The team lead',
      title: lead?.title ?? 'Operations lead',
      painPoint: rng.pick(PAIN_POINTS),
    }
    acc.caseKnowledge.push({
      id: rng.uuid(),
      client_id: seedCase.client_id,
      case_id: seedCase.id,
      kind,
      content: fill(rng.pick(KNOWLEDGE_TEMPLATES[kind]), vars),
      source_url: `https://${company.domain}/${kind === 'news' ? 'newsroom' : 'about'}`,
      citation: `${company.name} — ${kind === 'news' ? 'Newsroom' : 'Company site'}`,
      created_by: 'agent',
      created_at: isoAt(acc.windowStart, researchDay, rng.int(7, 11), rng.int(0, 59)),
    })
  }

  if (plan.knowledge === 'full') {
    const completedAt = isoAt(acc.windowStart, researchDay, 11, rng.int(0, 59))
    addEvent(acc, { clientId: seedCase.client_id, caseId: seedCase.id, actor: 'agent', type: 'pipeline.research.completed', createdAt: completedAt, payload: { entries: entryCount } })
    addEvent(acc, { clientId: seedCase.client_id, caseId: seedCase.id, actor: 'agent', type: 'llm.completed', createdAt: completedAt, payload: { model: 'gemini-2.5-flash', inputTokens: rng.int(1800, 6400), outputTokens: rng.int(200, 900) } })
  }
  return researchDay
}

// ---------- outreach ----------

interface EmailDraftInput {
  readonly clientId: string
  readonly caseId: string
  readonly leadId: string
  readonly threadId: string
  readonly mailbox: SeedMailbox
  readonly subject: string
  readonly body: string
  readonly step: number | null
  readonly dayIndex: number
  readonly status: Enums['email_status']
}

function pushOutbound(acc: Accumulator, input: EmailDraftInput & { inReplyTo?: string | null }): SeedEmail {
  const { rng } = acc
  const timestamp = businessHourIso(rng, acc.windowStart, input.dayIndex)
  // A draft was never handed to a provider, and a failed send never reaches one
  // either — analytics reads coalesce(sent_at, created_at), so both stay null.
  const isDelivered = input.status === 'sent' || input.status === 'delivered' || input.status === 'bounced'
  const email: SeedEmail = {
    id: rng.uuid(),
    client_id: input.clientId,
    case_id: input.caseId,
    lead_id: input.leadId,
    thread_id: input.threadId,
    provider_message_id: isDelivered ? `${input.mailbox.provider}-${rng.uuid()}` : null,
    direction: 'outbound',
    subject: input.subject,
    body: input.body,
    status: input.status,
    sequence_step: input.step,
    mailbox_id: input.mailbox.id,
    sent_at: isDelivered ? timestamp : null,
    in_reply_to_email_id: input.inReplyTo ?? null,
    created_at: timestamp,
  }
  acc.emails.push(email)
  return email
}

function buildTemplateVars(
  company: SeedCompanyFixture,
  lead: SeedLead,
  mailbox: SeedMailbox,
  campaign: SeedCampaign,
  painPoint: string,
  signal: string,
): Record<string, string> {
  const firstName = lead.full_name.split(' ')[0] ?? lead.full_name
  return {
    firstName,
    fullName: lead.full_name,
    company: company.name,
    industry: company.industry,
    city: company.city,
    employees: String(company.employees),
    painPoint,
    shortPain: painPoint,
    signal,
    valueProp: campaign.value_prop ?? '',
    bookingLink: campaign.booking_link ?? '',
    senderName: mailbox.display_name ?? 'The team',
  }
}

function buildOutreach(
  acc: Accumulator,
  context: CampaignContext,
  seedCase: SeedCase,
  company: SeedCompanyFixture,
  plan: CasePlan,
  knowledgeDay: number,
  leads: SeedLead[],
): void {
  const { rng } = acc
  const sendable = leads.filter((l) => l.email_status === 'verified' && l.status === 'active')
  if (sendable.length === 0 || context.mailboxes.length === 0) return

  const responderId = plan.replyIntent && rng.bool(plan.replyProbability) ? sendable[0]?.id ?? null : null
  let lastActivityDay = knowledgeDay

  for (const lead of sendable) {
    const day = buildLeadThread(acc, context, seedCase, company, plan, knowledgeDay, lead, lead.id === responderId)
    lastActivityDay = Math.max(lastActivityDay, day)
  }
  seedCase.updated_at = isoAt(acc.windowStart, lastActivityDay, rng.int(10, 18), rng.int(0, 59))
}

/** Builds one lead's full thread (first touch, follow-ups, reply exchange). Returns the last active day. */
function buildLeadThread(
  acc: Accumulator,
  context: CampaignContext,
  seedCase: SeedCase,
  company: SeedCompanyFixture,
  plan: CasePlan,
  knowledgeDay: number,
  lead: SeedLead,
  isResponder: boolean,
): number {
  const { rng } = acc
  const firstTouchDay = nextBusinessDay(acc.windowStart, Math.min(LAST_DAY_INDEX, knowledgeDay + rng.int(1, 3)))
  if (firstTouchDay === null) return knowledgeDay

  const mailbox = rng.pick(context.mailboxes)
  const threadId = `thread-${rng.uuid()}`
  const painPoint = rng.pick(PAIN_POINTS)
  const vars = buildTemplateVars(company, lead, mailbox, context.campaign, painPoint, rng.pick(SIGNALS))
  const subject = fill(rng.pick(SUBJECT_TEMPLATES), vars)

  const status = pickFirstTouchStatus(acc, context, plan, isResponder)
  const firstTouch = pushOutbound(acc, {
    clientId: seedCase.client_id, caseId: seedCase.id, leadId: lead.id, threadId, mailbox,
    subject, body: buildOutboundBody(rng, vars), step: 0, dayIndex: firstTouchDay, status,
  })
  addEvent(acc, { clientId: seedCase.client_id, caseId: seedCase.id, actor: 'pipeline', type: 'pipeline.write.completed', createdAt: firstTouch.created_at ?? '', payload: { step: 0, status } })

  if (status === 'bounced') return handleBounce(acc, seedCase, lead, firstTouchDay, mailbox, threadId)
  if (status === 'draft') return firstTouchDay

  const lastStep = isResponder
    ? { day: firstTouchDay, step: 0 }
    : buildFollowups(acc, seedCase, lead, mailbox, threadId, subject, vars, firstTouchDay)

  if (!isResponder || !plan.replyIntent) {
    pushSequence(acc, seedCase, lead, plan.sequenceState ?? 'active', lastStep.step, lastStep.day)
    return lastStep.day
  }
  return buildReplyExchange(acc, context, seedCase, lead, mailbox, threadId, subject, vars, plan, firstTouchDay)
}

function pickFirstTouchStatus(
  acc: Accumulator,
  context: CampaignContext,
  plan: CasePlan,
  isResponder: boolean,
): Enums['email_status'] {
  // A responder must have actually received the mail, so its first touch is
  // never a draft, a bounce, or a failure.
  if (isResponder) return acc.rng.bool(0.6) ? 'delivered' : 'sent'
  const canDraft =
    context.fixture.replyMode === 'human_approve' &&
    acc.counters.firstTouchDrafts < MAX_FIRST_TOUCH_DRAFTS &&
    plan.sequenceState === 'active'
  if (canDraft && acc.rng.bool(0.08)) {
    acc.counters.firstTouchDrafts += 1
    return 'draft'
  }
  return acc.rng.weighted(SEND_OUTCOMES)
}

function handleBounce(
  acc: Accumulator,
  seedCase: SeedCase,
  lead: SeedLead,
  dayIndex: number,
  mailbox: SeedMailbox,
  threadId: string,
): number {
  if (lead.email) {
    addSuppression(acc, {
      clientId: seedCase.client_id,
      email: lead.email,
      reason: 'bounced',
      createdAt: businessHourIso(acc.rng, acc.windowStart, dayIndex),
    })
  }
  pushSequence(acc, seedCase, lead, 'stopped', 0, dayIndex)
  addEvent(acc, {
    clientId: seedCase.client_id, caseId: seedCase.id, actor: 'pipeline', type: 'pipeline.followup.exhausted',
    createdAt: businessHourIso(acc.rng, acc.windowStart, dayIndex),
    payload: { reason: 'bounced', mailbox: mailbox.email_address, threadId },
  })
  return dayIndex
}

function buildOutboundBody(rng: Rng, vars: Readonly<Record<string, string>>): string {
  return [
    fill(rng.pick(OPENING_TEMPLATES), vars),
    fill(rng.pick(PITCH_TEMPLATES), vars),
    fill(rng.pick(CLOSING_TEMPLATES), vars),
  ].join('\n\n')
}

function buildFollowups(
  acc: Accumulator,
  seedCase: SeedCase,
  lead: SeedLead,
  mailbox: SeedMailbox,
  threadId: string,
  subject: string,
  vars: Readonly<Record<string, string>>,
  firstTouchDay: number,
): { day: number; step: number } {
  const { rng } = acc
  let lastDay = firstTouchDay
  let lastStep = 0

  for (const [offsetIndex, offset] of FOLLOWUP_OFFSETS.entries()) {
    const target = firstTouchDay + offset
    if (target > LAST_DAY_INDEX) break
    const day = nextBusinessDay(acc.windowStart, target)
    if (day === null) break
    const step = offsetIndex + 1
    const status = rng.weighted(SEND_OUTCOMES.filter(([value]) => value !== 'bounced'))
    const email = pushOutbound(acc, {
      clientId: seedCase.client_id, caseId: seedCase.id, leadId: lead.id, threadId, mailbox,
      subject: `${FOLLOWUP_SUBJECT_PREFIX}${subject}`,
      body: fill(rng.pick(FOLLOWUP_BODIES), vars), step, dayIndex: day, status,
    })
    addEvent(acc, {
      clientId: seedCase.client_id, caseId: seedCase.id, actor: 'pipeline', type: 'pipeline.followup.sent',
      createdAt: email.created_at ?? '', payload: { step },
    })
    lastDay = day
    lastStep = step
  }
  return { day: lastDay, step: lastStep }
}

// ---------- replies ----------

function buildReplyExchange(
  acc: Accumulator,
  context: CampaignContext,
  seedCase: SeedCase,
  lead: SeedLead,
  mailbox: SeedMailbox,
  threadId: string,
  subject: string,
  vars: Readonly<Record<string, string>>,
  plan: CasePlan,
  firstTouchDay: number,
): number {
  const { rng } = acc
  const intent = plan.replyIntent
  if (!intent) return firstTouchDay
  const replyDay = nextBusinessDay(acc.windowStart, Math.min(LAST_DAY_INDEX, firstTouchDay + rng.int(1, 4)))
  if (replyDay === null) return firstTouchDay

  const candidates = REPLY_FIXTURES.filter((r) => r.intent === intent)
  const replyBody = (candidates.length > 0 ? rng.pick(candidates) : rng.pick(REPLY_FIXTURES)).body
  const inbound: SeedEmail = {
    id: rng.uuid(),
    client_id: seedCase.client_id,
    case_id: seedCase.id,
    lead_id: lead.id,
    thread_id: threadId,
    provider_message_id: `${mailbox.provider}-inbound-${rng.uuid()}`,
    direction: 'inbound',
    subject: `${FOLLOWUP_SUBJECT_PREFIX}${subject}`,
    body: replyBody,
    status: 'delivered',
    sequence_step: null,
    mailbox_id: mailbox.id,
    sent_at: businessHourIso(rng, acc.windowStart, replyDay),
    in_reply_to_email_id: null,
    created_at: businessHourIso(rng, acc.windowStart, replyDay),
  }
  acc.emails.push(inbound)
  addEvent(acc, { clientId: seedCase.client_id, caseId: seedCase.id, actor: 'pipeline', type: 'inbound.received', createdAt: inbound.created_at ?? '', payload: { intent } })

  recordReplySideEffects(acc, seedCase, lead, intent, replyDay)
  const answeredDay = buildReplyAnswer(acc, context, seedCase, lead, mailbox, threadId, subject, vars, intent, inbound, replyDay)
  pushSequence(acc, seedCase, lead, intent === 'opt_out' ? 'stopped' : plan.sequenceState ?? 'completed', 0, answeredDay)
  return answeredDay
}

function recordReplySideEffects(
  acc: Accumulator,
  seedCase: SeedCase,
  lead: SeedLead,
  intent: ReplyIntent,
  replyDay: number,
): void {
  const createdAt = businessHourIso(acc.rng, acc.windowStart, replyDay)
  const eventType = intent === 'price' ? 'reply.price_handoff' : intent === 'opt_out' ? 'reply.opt_out' : 'reply.answered'
  addEvent(acc, { clientId: seedCase.client_id, caseId: seedCase.id, actor: 'agent', type: eventType, createdAt, payload: { intent } })
  addEvent(acc, { clientId: seedCase.client_id, caseId: seedCase.id, actor: 'pipeline', type: 'pipeline.followup.completed_on_reply', createdAt, payload: { intent } })
  if (!lead.email) return
  // Anyone who replies stops receiving the sequence — the reason differs by intent.
  const reason: Enums['suppression_reason'] = intent === 'price' ? 'price_handoff' : intent === 'opt_out' ? 'manual' : 'replied'
  addSuppression(acc, { clientId: seedCase.client_id, email: lead.email, reason, createdAt })
}

/** Sends (or drafts) the agent's answer, optionally escalating a knowledge gap. Returns the day it happened. */
function buildReplyAnswer(
  acc: Accumulator,
  context: CampaignContext,
  seedCase: SeedCase,
  lead: SeedLead,
  mailbox: SeedMailbox,
  threadId: string,
  subject: string,
  vars: Readonly<Record<string, string>>,
  intent: ReplyIntent,
  inbound: SeedEmail,
  replyDay: number,
): number {
  const { rng } = acc
  const answerDay = nextBusinessDay(acc.windowStart, Math.min(LAST_DAY_INDEX, replyDay + rng.int(0, 1))) ?? replyDay

  if (intent === 'question' || (intent === 'price' && rng.bool(0.4))) {
    const escalated = buildKnowledgeRequest(acc, seedCase, lead, inbound, answerDay)
    // An escalated question waits on a human, so no outbound answer exists yet.
    if (escalated) return answerDay
  }

  const isDraft =
    context.fixture.replyMode === 'human_approve' &&
    acc.counters.replyDrafts < MAX_REPLY_DRAFTS &&
    rng.bool(0.5)
  if (isDraft) acc.counters.replyDrafts += 1

  pushOutbound(acc, {
    clientId: seedCase.client_id, caseId: seedCase.id, leadId: lead.id, threadId, mailbox,
    subject: `${FOLLOWUP_SUBJECT_PREFIX}${subject}`,
    body: fill(REPLY_OUTBOUND_TEMPLATES[intent], vars),
    // Replies carry a null sequence_step: they are not part of the cadence, and
    // the (lead_id, sequence_step, direction) unique index treats nulls as distinct.
    step: null,
    dayIndex: answerDay,
    status: isDraft ? 'draft' : rng.bool(0.7) ? 'delivered' : 'sent',
    inReplyTo: inbound.id,
  })
  return answerDay
}

/** Returns true when a request was created (the per-run caps can refuse). */
function buildKnowledgeRequest(
  acc: Accumulator,
  seedCase: SeedCase,
  lead: SeedLead,
  inbound: SeedEmail,
  dayIndex: number,
): boolean {
  const { rng, counters } = acc
  const wantsOpen = counters.openRequests < MAX_OPEN_KNOWLEDGE_REQUESTS
  const wantsClosed = counters.closedRequests < MAX_CLOSED_KNOWLEDGE_REQUESTS
  if (!wantsOpen && !wantsClosed) return false

  const isOpen = wantsOpen && (!wantsClosed || rng.bool(0.5))
  if (isOpen) counters.openRequests += 1
  else counters.closedRequests += 1

  const createdAt = businessHourIso(rng, acc.windowStart, dayIndex)
  const status: Enums['knowledge_req_status'] = isOpen ? 'open' : rng.bool(0.75) ? 'answered' : 'dismissed'
  const isAnswered = status === 'answered'
  acc.knowledgeRequests.push({
    id: rng.uuid(),
    client_id: seedCase.client_id,
    case_id: seedCase.id,
    lead_id: lead.id,
    email_id: inbound.id,
    question: rng.pick(KNOWLEDGE_REQUEST_QUESTIONS),
    status,
    human_answer: isAnswered ? rng.pick(KNOWLEDGE_REQUEST_ANSWERS) : null,
    answered_by: isAnswered ? acc.operatorUserId : null,
    answered_at: isAnswered ? createdAt : null,
    created_at: createdAt,
  })
  addEvent(acc, {
    clientId: seedCase.client_id, caseId: seedCase.id, actor: 'agent',
    type: isAnswered ? 'reply.knowledge_answered' : 'reply.knowledge_gap',
    createdAt, payload: { status },
  })
  return true
}

// ---------- sequences ----------

function pushSequence(
  acc: Accumulator,
  seedCase: SeedCase,
  lead: SeedLead,
  state: Enums['sequence_state'],
  currentStep: number,
  dayIndex: number,
): void {
  const { rng } = acc
  // sequences_lead_uniq allows exactly one row per lead.
  if (acc.sequences.some((s) => s.lead_id === lead.id)) return
  const isExhausted = currentStep >= MAX_SEQUENCE_STEP
  const resolvedState: Enums['sequence_state'] =
    state === 'active' && isExhausted ? 'completed' : state === 'active' && rng.bool(0.1) ? 'paused' : state
  const updatedAt = businessHourIso(rng, acc.windowStart, dayIndex)

  acc.sequences.push({
    id: rng.uuid(),
    client_id: seedCase.client_id,
    case_id: seedCase.id,
    lead_id: lead.id,
    state: resolvedState,
    current_step: currentStep,
    // Only a live cadence has a scheduled next touch.
    next_action_at: resolvedState === 'active'
      ? new Date(Date.parse(updatedAt) + rng.int(1, 4) * MS_PER_DAY).toISOString()
      : null,
    qstash_message_id: resolvedState === 'active' ? `msg_${rng.uuid().slice(0, 12)}` : null,
    created_at: businessHourIso(rng, acc.windowStart, dayIndex),
    updated_at: updatedAt,
  })
}

// ---------- cron chatter ----------

function buildCronEvents(acc: Accumulator): void {
  const { rng } = acc
  for (let day = 0; day <= LAST_DAY_INDEX; day++) {
    const isQuiet = isWeekend(acc.windowStart, day)
    for (const [index, type] of DAILY_CRON_EVENTS.entries()) {
      addEvent(acc, {
        clientId: null,
        actor: 'cron',
        type,
        createdAt: isoAt(acc.windowStart, day, 5 + index, rng.int(0, 59)),
        payload: { processed: isQuiet ? 0 : rng.int(1, 12) },
      })
    }
  }
}
