import { assertNoHeaderInjection } from '@/lib/mailbox/headers'

// The agency's booking link for clients to flag an issue or talk it
// through — a fixed, non-secret constant, not env (spec §6).
export const FEEDBACK_CALL_URL = 'https://cal.com/shengul-yavuz/feedback-call'

export interface ReportEmailTemplateInput {
  clientName: string
  periodLabel: 'this week' | 'this month'
  leadsFound: number
  emailsSent: number
  repliesReceived: number
  reportUrl: string
}

export interface RenderedReportEmail {
  subject: string
  text: string
  html: string
}

interface ReportEmailTemplate {
  subject: (input: ReportEmailTemplateInput) => string
  body: (input: ReportEmailTemplateInput) => string
}

// Greets by company name, not a person's name — the invite flow only ever
// captures an email address, there is no name field for a dashboard user
// (spec §6).
const SIGNATURE = 'Shengul Yavuz\nFounder of Shengul AI'

const TEMPLATES: readonly ReportEmailTemplate[] = [
  {
    subject: ({ periodLabel }) => `Shengul AI: your ${periodLabel} numbers are in`,
    body: ({ clientName, leadsFound, periodLabel, emailsSent, reportUrl }) =>
      `Hey ${clientName} team,\n\n` +
      `${leadsFound} new leads this ${periodLabel}, ${emailsSent} emails out the door. Full report here: ${reportUrl}\n\n` +
      `Something look off? Reply to this email or grab 15 minutes on my calendar: ${FEEDBACK_CALL_URL}\n\n` +
      `— Shengul\n\n${SIGNATURE}`,
  },
  {
    subject: ({ clientName, leadsFound }) => `Shengul AI — ${leadsFound} new leads for ${clientName}`,
    body: ({ clientName, periodLabel, leadsFound, repliesReceived, reportUrl }) =>
      `Hi ${clientName},\n\n` +
      `${periodLabel}'s numbers: ${leadsFound} leads found, ${repliesReceived} replies back. Report's here: ${reportUrl}\n\n` +
      `If anything doesn't add up, tell me — reply here or book time: ${FEEDBACK_CALL_URL}\n\n` +
      `Talk soon,\nShengul\n\n${SIGNATURE}`,
  },
  {
    subject: ({ clientName, periodLabel }) => `${clientName}'s ${periodLabel} report is ready (Shengul AI)`,
    body: ({ clientName, leadsFound, emailsSent, periodLabel, reportUrl }) =>
      `Hey ${clientName} team,\n\n` +
      `Report's in: ${leadsFound} new leads, ${emailsSent} emails sent ${periodLabel}. Take a look: ${reportUrl}\n\n` +
      `Anything look wrong, or want to talk it through? Book a call: ${FEEDBACK_CALL_URL}\n\n` +
      `Best,\nShengul\n\n${SIGNATURE}`,
  },
  {
    subject: ({ clientName, periodLabel }) => `Shengul AI report: ${clientName}, ${periodLabel}`,
    body: ({ clientName, periodLabel, leadsFound, repliesReceived, reportUrl }) =>
      `Hi ${clientName},\n\n` +
      `Wrapped up ${periodLabel}: ${leadsFound} leads, ${repliesReceived} replies so far. Details here: ${reportUrl}\n\n` +
      `Flag anything that seems off, or just grab time on my calendar: ${FEEDBACK_CALL_URL}\n\n` +
      `— Shengul\n\n${SIGNATURE}`,
  },
  {
    subject: ({ leadsFound, clientName }) => `${leadsFound} new leads for ${clientName} — Shengul AI`,
    body: ({ clientName, leadsFound, periodLabel, emailsSent, reportUrl }) =>
      `Hey ${clientName} team,\n\n` +
      `${leadsFound} leads found ${periodLabel}, ${emailsSent} emails sent. Everything's in the report: ${reportUrl}\n\n` +
      `Questions or something's wrong — write back anytime, or book 15 minutes: ${FEEDBACK_CALL_URL}\n\n` +
      `Thanks,\nShengul\n\n${SIGNATURE}`,
  },
  {
    subject: ({ periodLabel }) => `Your ${periodLabel} update from Shengul AI`,
    body: ({ clientName, periodLabel, leadsFound, emailsSent, repliesReceived, reportUrl }) =>
      `Hi ${clientName},\n\n` +
      `Here's ${periodLabel}: ${leadsFound} leads, ${emailsSent} emails out, ${repliesReceived} replies. Full breakdown: ${reportUrl}\n\n` +
      `Doesn't look right, or want to dig in together? Grab time here: ${FEEDBACK_CALL_URL}\n\n` +
      `— Shengul\n\n${SIGNATURE}`,
  },
  {
    subject: ({ clientName, periodLabel }) => `Shengul AI — checking in on ${clientName}'s ${periodLabel}`,
    body: ({ clientName, periodLabel, leadsFound, repliesReceived, reportUrl }) =>
      `Hey ${clientName} team,\n\n` +
      `${periodLabel} report's ready — ${leadsFound} leads, ${repliesReceived} replies so far. See everything here: ${reportUrl}\n\n` +
      `Something off? Reply to this email, or book a call and we'll sort it: ${FEEDBACK_CALL_URL}\n\n` +
      `Talk soon,\nShengul\n\n${SIGNATURE}`,
  },
]

// Deterministic, never repeats back-to-back across a client's reports —
// spec §6.
export function pickTemplate(priorReportCount: number): ReportEmailTemplate {
  return TEMPLATES[priorReportCount % TEMPLATES.length]!
}

function toHtml(text: string): string {
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  // white-space: pre-line renders the \n\n paragraph breaks without needing
  // <br>/<p> markup — minimal styling on purpose, so this reads as an
  // actual personal email rather than a marketing template (spec §6).
  return (
    '<div style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; ' +
    'font-size: 14px; line-height: 1.6; color: #1a1a1a; white-space: pre-line;">' +
    `${escaped}</div>`
  )
}

export function renderTemplate(
  template: ReportEmailTemplate,
  input: ReportEmailTemplateInput,
): RenderedReportEmail {
  const clientName = assertNoHeaderInjection(input.clientName, 'clientName')
  const safeInput = { ...input, clientName }
  const subject = assertNoHeaderInjection(template.subject(safeInput), 'subject')
  const text = template.body(safeInput)
  return { subject, text, html: toHtml(text) }
}
