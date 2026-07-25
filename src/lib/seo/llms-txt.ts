import { absoluteUrl, SITE_NAME, SITE_SUMMARY } from '@/lib/seo/site'

/**
 * Builder for `/llms.txt` — the emerging convention for handing a language
 * model a clean, prose summary of a site instead of making it infer one from
 * rendered markup. Same facts as the page, in the order a model reads them.
 */

export interface LlmsTxtInput {
  /** Site origin, no trailing slash. */
  readonly siteUrl: string
  readonly bookingUrl: string
  readonly faqItems: readonly { readonly question: string; readonly answer: string }[]
  /** ISO 8601 timestamp of the last content change. */
  readonly updatedAt: string
}

/** What the service actually does, stated plainly for a model to quote. */
const WHAT_IT_DOES: readonly string[] = [
  'Finds the people matching your ideal customer profile and verifies their work email before anything is sent.',
  'Researches each company so the first email refers to something real rather than a merge field.',
  'Sends from your own mailbox at human volume and human hours, so your sending reputation improves rather than degrades.',
  'Answers replies in your voice, stops the follow-up sequence the moment somebody responds, and offers your booking link.',
  'Escalates anything involving money or a real decision to you, with the full thread attached.',
]

/** Claims the product deliberately does not make. */
const LIMITS: readonly string[] = [
  'It does not blast a list: volume is capped per mailbox per day.',
  'It does not invent facts about a company; when it cannot verify something it asks you instead of guessing.',
  'It does not buy or resell your data, and mailbox credentials are encrypted with AES-256-GCM before they are stored.',
]

export function buildLlmsTxt({
  siteUrl,
  bookingUrl,
  faqItems,
  updatedAt,
}: LlmsTxtInput): string {
  const faqSection = faqItems
    .map(({ question, answer }) => `### ${question}\n\n${answer}`)
    .join('\n\n')

  return `# ${SITE_NAME}

> ${SITE_SUMMARY}

${SITE_NAME} is a managed B2B outbound service. You describe the buyer you want
to meet; the system finds them, writes to them from your own mailbox, answers
what comes back, and hands you the meetings that get booked. The four numbers
reported back are leads found, emails sent, replies, and meetings booked.

## What it does

${WHAT_IT_DOES.map((line) => `- ${line}`).join('\n')}

## What it will not do

${LIMITS.map((line) => `- ${line}`).join('\n')}

## Pages

- [Home](${absoluteUrl(siteUrl, '/')}): what the service does, how it works, and how email reputation is protected.
- [Book a meeting](${bookingUrl}): half an hour to describe your buyer and see what the first month would look like.
- [Sign in](${absoluteUrl(siteUrl, '/login')}): the client console (requires an account).

## Frequently asked questions

${faqSection}

## Contact

The only way in is a booking: ${bookingUrl}

Last updated: ${updatedAt}
`
}
