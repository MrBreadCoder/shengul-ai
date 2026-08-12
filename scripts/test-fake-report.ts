// Standalone preview: generates fake weekly + monthly reports (no AI call,
// no real client data) and emails them to shengul@shengulai.com through the
// real mailer + real template rotation, so the actual rendering — email and
// the report page it links to — can be checked in a real inbox before this
// ships. Writes real `reports` rows through the real upsertReport() — the
// "View Full Report" link in a fake email must resolve to a real page with
// real charts, or the preview doesn't show the thing that matters most. It
// never calls generateReportCommentary (no AI call, per your ask) and never
// runs real recipient resolution — every email goes to one hardcoded
// address. See design spec §10.
//
//   pnpm test-fake-report                        # both types, demo client
//   pnpm test-fake-report --type=weekly           # --type=weekly|monthly|both
//   pnpm test-fake-report --client-id=<uuid>      # default: getOrCreateOperatorClient()
import { z } from 'zod'
import { AppError } from '../src/lib/errors/app-error'
import type { OverviewMetrics } from '../src/types/analytics'

const PREVIEW_RECIPIENT = 'shengul@shengulai.com'
const MS_PER_DAY = 86_400_000
const WEEKS_OF_HISTORY = 4

const argsSchema = z.object({
  type: z.enum(['weekly', 'monthly', 'both']),
  clientId: z.string().uuid().optional(),
})

function parseArgs(argv: readonly string[]): z.infer<typeof argsSchema> {
  const typeArg = argv.find((arg) => arg.startsWith('--type='))?.slice('--type='.length) ?? 'both'
  const clientIdArg = argv.find((arg) => arg.startsWith('--client-id='))?.slice('--client-id='.length)
  const parsed = argsSchema.safeParse({ type: typeArg, clientId: clientIdArg })
  if (!parsed.success) {
    throw new AppError('VALIDATION_ERROR', `Invalid arguments: ${parsed.error.message}`, {})
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

interface AppDeps {
  createAdminClient: typeof import('../src/lib/supabase/admin').createAdminClient
  getOrCreateOperatorClient: typeof import('../src/lib/db/clients').getOrCreateOperatorClient
  getClientById: typeof import('../src/lib/db/clients').getClientById
  upsertReport: typeof import('../src/lib/db/reports').upsertReport
  getWeeklyPeriod: typeof import('../src/lib/reports/period').getWeeklyPeriod
  getMonthlyPeriod: typeof import('../src/lib/reports/period').getMonthlyPeriod
  pickTemplate: typeof import('../src/lib/reports/email-templates').pickTemplate
  renderTemplate: typeof import('../src/lib/reports/email-templates').renderTemplate
  sendReportEmail: typeof import('../src/lib/reports/mailer').sendReportEmail
}

async function loadAppDeps(): Promise<AppDeps> {
  const [adminMod, clientsMod, reportsMod, periodMod, templatesMod, mailerMod] = await Promise.all([
    import('../src/lib/supabase/admin'),
    import('../src/lib/db/clients'),
    import('../src/lib/db/reports'),
    import('../src/lib/reports/period'),
    import('../src/lib/reports/email-templates'),
    import('../src/lib/reports/mailer'),
  ])
  return {
    createAdminClient: adminMod.createAdminClient,
    getOrCreateOperatorClient: clientsMod.getOrCreateOperatorClient,
    getClientById: clientsMod.getClientById,
    upsertReport: reportsMod.upsertReport,
    getWeeklyPeriod: periodMod.getWeeklyPeriod,
    getMonthlyPeriod: periodMod.getMonthlyPeriod,
    pickTemplate: templatesMod.pickTemplate,
    renderTemplate: templatesMod.renderTemplate,
    sendReportEmail: mailerMod.sendReportEmail,
  }
}

const FAKE_COMMENTARY = {
  headline: 'A strong stretch for replies',
  summary:
    'Outreach stayed steady this period with a healthy mix of new leads and follow-ups. Reply activity ' +
    'picked up notably, with several conversations already moving toward a call.',
  highlights: [
    'Reply rate trending up compared to the prior period',
    'Case volume holding steady across active campaigns',
    'Bounce rate stayed low — deliverability looks healthy',
  ],
}

function randomBetween(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

interface FakeDailyPoint {
  day: string
  leadsDiscovered: number
  emailsSent: number
  repliesReceived: number
}

function buildFakeDaily(periodStart: string, periodEnd: string): FakeDailyPoint[] {
  const days: FakeDailyPoint[] = []
  const start = new Date(periodStart).getTime()
  const end = new Date(periodEnd).getTime()
  for (let t = start; t < end; t += MS_PER_DAY) {
    days.push({
      day: new Date(t).toISOString().slice(0, 10),
      leadsDiscovered: randomBetween(0, 4),
      emailsSent: randomBetween(2, 10),
      repliesReceived: randomBetween(0, 2),
    })
  }
  return days
}

function sumField(daily: FakeDailyPoint[], field: keyof Omit<FakeDailyPoint, 'day'>): number {
  return daily.reduce((total, day) => total + day[field], 0)
}

function buildFakeOverview(daily: FakeDailyPoint[]): OverviewMetrics {
  const leadsDiscovered = sumField(daily, 'leadsDiscovered')
  const emailsSent = sumField(daily, 'emailsSent')
  const repliesReceived = sumField(daily, 'repliesReceived')
  const firstTouchSent = Math.floor(emailsSent * 0.6)
  return {
    leadsDiscovered,
    leadsVerified: leadsDiscovered,
    casesCreated: randomBetween(0, Math.max(1, Math.floor(leadsDiscovered / 3))),
    emailsSent,
    firstTouchSent,
    followupsSent: emailsSent - firstTouchSent,
    emailsBounced: randomBetween(0, 1),
    emailsFailed: 0,
    repliesReceived,
    leadsContacted: emailsSent,
    leadsReplied: repliesReceived,
    suppressionsAdded: randomBetween(0, 1),
    activeSequences: randomBetween(1, 5),
  }
}

interface FakeWeeklyBreakdownEntry {
  reportId: string
  periodStart: string
  periodEnd: string
  overview: OverviewMetrics
}

function buildFakeMetricsSnapshot(periodStart: string, periodEnd: string, weeklyBreakdown?: FakeWeeklyBreakdownEntry[]) {
  const daily = buildFakeDaily(periodStart, periodEnd)
  const overview = buildFakeOverview(daily)
  return { overview, daily, ...(weeklyBreakdown ? { weeklyBreakdown } : {}) }
}

interface FakeReportSummary {
  type: 'weekly' | 'monthly'
  reportId: string
  url: string
  emailed: boolean
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  loadEnv()
  const deps = await loadAppDeps()
  const admin = deps.createAdminClient()

  const clientId = args.clientId ?? (await deps.getOrCreateOperatorClient(admin))
  const client = await deps.getClientById(admin, clientId)
  if (!client) {
    throw new AppError('NOT_FOUND', 'Client not found', { clientId })
  }

  const appUrl = process.env.APP_URL ?? 'http://localhost:3000'
  // Captured as its own const, not read as `client.name` inside the closure
  // below: `client` is already null-checked above, but TypeScript does not
  // carry that narrowing for a nullable binding referenced from inside a
  // nested function declaration, so `client.name` there would still report
  // "possibly null" — pulling the one field out here avoids re-touching the
  // nullable binding at all.
  const clientName = client.name
  const summaries: FakeReportSummary[] = []
  const weeklyBreakdown: FakeWeeklyBreakdownEntry[] = []

  async function emailPreview(
    reportId: string,
    periodLabel: 'this week' | 'this month',
    overview: OverviewMetrics,
  ): Promise<void> {
    const template = deps.pickTemplate(summaries.length)
    const rendered = deps.renderTemplate(template, {
      clientName,
      periodLabel,
      leadsFound: overview.leadsDiscovered,
      emailsSent: overview.emailsSent,
      repliesReceived: overview.repliesReceived,
      reportUrl: new URL(`/reports/${reportId}`, appUrl).toString(),
    })
    await deps.sendReportEmail({ to: PREVIEW_RECIPIENT, subject: rendered.subject, text: rendered.text, html: rendered.html })
  }

  if (args.type === 'weekly' || args.type === 'both') {
    // 4 silent backdated weeks — scaffolding so the monthly preview's
    // weekly-recap table has real rows to show and link to. No email sent
    // for these.
    for (let weeksAgo = WEEKS_OF_HISTORY; weeksAgo >= 1; weeksAgo -= 1) {
      const backdatedNow = new Date(Date.now() - weeksAgo * 7 * MS_PER_DAY)
      const period = deps.getWeeklyPeriod(backdatedNow)
      const metrics = buildFakeMetricsSnapshot(period.periodStart, period.periodEnd)
      const report = await deps.upsertReport(admin, {
        clientId,
        type: 'weekly',
        periodStart: period.periodStart,
        periodEnd: period.periodEnd,
        metrics,
        aiHeadline: FAKE_COMMENTARY.headline,
        aiSummary: FAKE_COMMENTARY.summary,
        aiHighlights: FAKE_COMMENTARY.highlights,
        status: 'ready',
      })
      weeklyBreakdown.push({ reportId: report.id, periodStart: period.periodStart, periodEnd: period.periodEnd, overview: metrics.overview })
      summaries.push({ type: 'weekly', reportId: report.id, url: `/reports/${report.id}`, emailed: false })
    }

    // Current week — this one gets emailed.
    const currentPeriod = deps.getWeeklyPeriod(new Date())
    const currentMetrics = buildFakeMetricsSnapshot(currentPeriod.periodStart, currentPeriod.periodEnd)
    const currentReport = await deps.upsertReport(admin, {
      clientId,
      type: 'weekly',
      periodStart: currentPeriod.periodStart,
      periodEnd: currentPeriod.periodEnd,
      metrics: currentMetrics,
      aiHeadline: FAKE_COMMENTARY.headline,
      aiSummary: FAKE_COMMENTARY.summary,
      aiHighlights: FAKE_COMMENTARY.highlights,
      status: 'sent',
    })
    await emailPreview(currentReport.id, 'this week', currentMetrics.overview)
    summaries.push({ type: 'weekly', reportId: currentReport.id, url: `/reports/${currentReport.id}`, emailed: true })
  }

  if (args.type === 'monthly' || args.type === 'both') {
    // If --type=monthly was passed alone, weeklyBreakdown stays empty here
    // (the weekly block above didn't run) — the monthly preview still
    // generates, just without a populated recap table. Expected: --type=both
    // (the default) is the path that shows the full picture.
    const monthlyPeriod = deps.getMonthlyPeriod(new Date())
    const monthlyMetrics = buildFakeMetricsSnapshot(monthlyPeriod.periodStart, monthlyPeriod.periodEnd, weeklyBreakdown)
    const monthlyReport = await deps.upsertReport(admin, {
      clientId,
      type: 'monthly',
      periodStart: monthlyPeriod.periodStart,
      periodEnd: monthlyPeriod.periodEnd,
      metrics: monthlyMetrics,
      aiHeadline: FAKE_COMMENTARY.headline,
      aiSummary: FAKE_COMMENTARY.summary,
      aiHighlights: FAKE_COMMENTARY.highlights,
      status: 'sent',
    })
    await emailPreview(monthlyReport.id, 'this month', monthlyMetrics.overview)
    summaries.push({ type: 'monthly', reportId: monthlyReport.id, url: `/reports/${monthlyReport.id}`, emailed: true })
  }

  console.log(`\n${'='.repeat(72)}`)
  console.log('FAKE REPORTS GENERATED')
  console.log('='.repeat(72))
  for (const summary of summaries) {
    console.log(`${summary.type.padEnd(8)} ${summary.reportId}  ${appUrl}${summary.url}  ${summary.emailed ? '(emailed)' : '(silent, for weekly recap)'}`)
  }
  console.log('='.repeat(72))
  console.log(`Preview emails sent to: ${PREVIEW_RECIPIENT}\n`)
}

main().catch((error) => {
  if (error instanceof AppError) {
    console.error(`[${error.code}] ${error.message}`, error.context)
  } else {
    console.error(error)
  }
  process.exitCode = 1
})
