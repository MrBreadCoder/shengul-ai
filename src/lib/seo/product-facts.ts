/**
 * What the product does, stated plainly for a machine to quote.
 *
 * Extracted from `llms-txt.ts` once a second machine-readable surface needed
 * the same sentences: `/llms.txt` for a crawler, and the `getProductOverview`
 * WebMCP tool for an agent standing on the page. Same reasoning as
 * `@/lib/seo/site` — one source, so the two answers cannot diverge.
 */

/** The elevator paragraph. Written as one block so it reads as prose, not bullets. */
export const PRODUCT_OVERVIEW =
  'A managed B2B outbound service. You describe the buyer you want to meet; the system finds them, writes to them from your own mailbox, answers what comes back, and hands you the meetings that get booked. The four numbers reported back are leads found, emails sent, replies, and meetings booked.'

/** What the service actually does. */
export const WHAT_IT_DOES: readonly string[] = [
  'Finds the people matching your ideal customer profile and verifies their work email before anything is sent.',
  'Researches each company so the first email refers to something real rather than a merge field.',
  'Sends from your own mailbox at human volume and human hours, so your sending reputation improves rather than degrades.',
  'Answers replies in your voice, stops the follow-up sequence the moment somebody responds, and offers your booking link.',
  'Escalates anything involving money or a real decision to you, with the full thread attached.',
]

/** Claims the product deliberately does not make. */
export const LIMITS: readonly string[] = [
  'It does not blast a list: volume is capped per mailbox per day.',
  'It does not invent facts about a company; when it cannot verify something it asks you instead of guessing.',
  'It does not buy or resell your data, and mailbox credentials are encrypted with AES-256-GCM before they are stored.',
]
