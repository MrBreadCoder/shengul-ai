import { z } from 'zod'
import { BOOKING_URL } from '@/components/landing/constants'
import { FAQ_ITEMS } from '@/components/landing/faq-items'
import { LIMITS, PRODUCT_OVERVIEW, WHAT_IT_DOES } from '@/lib/seo/product-facts'
import { SITE_NAME, SITE_SUMMARY } from '@/lib/seo/site'
import type { WebMcpTool } from '@/types/webmcp'
import { defineWebMcpTool } from './define-tool'
import { matchFaqItems } from './faq-match'
import { jsonResult, textResult } from './result'

/**
 * The tools the public marketing page hands a browsing agent.
 *
 * All three are read-only and answer from copy already on the page — the same
 * facts `/llms.txt` and the JSON-LD serve. The page has no form and no session,
 * so there is nothing here an agent could mutate.
 *
 * Built as a plain factory rather than inside the component so the descriptors
 * can be asserted in a Node test, with no DOM and no React.
 */

/** Enough to answer a question without dumping the whole FAQ into the transcript. */
const MAX_FAQ_MATCHES = 3

/** A no-argument tool still needs an object schema — MCP has no "void" input. */
const noInputSchema = z.object({})

const answerFaqSchema = z.object({
  question: z
    .string()
    .trim()
    .min(1, 'Ask a question in plain words.')
    .max(500, 'Shorten the question to 500 characters or fewer.')
    .describe('What the visitor wants to know, in their own words.'),
})

function getProductOverviewTool(): WebMcpTool {
  return defineWebMcpTool({
    name: 'getProductOverview',
    title: 'What this service does',
    description: `A factual summary of ${SITE_NAME}: what it does, what it deliberately does not do, and the numbers it reports. Use this instead of summarising the page's marketing copy.`,
    inputSchema: noInputSchema,
    isReadOnly: true,
    execute: () => ({
      name: SITE_NAME,
      summary: SITE_SUMMARY,
      overview: PRODUCT_OVERVIEW,
      whatItDoes: WHAT_IT_DOES,
      whatItWillNotDo: LIMITS,
      bookingUrl: BOOKING_URL,
    }),
    toResult: jsonResult,
  })
}

function answerFaqTool(): WebMcpTool {
  return defineWebMcpTool({
    name: 'answerFaq',
    title: 'Answer a question about the service',
    description: `Answers a question about ${SITE_NAME} using the published FAQ. Returns the matching questions and their answers verbatim, so nothing has to be inferred. Returns no matches when the FAQ does not cover the question — say so rather than guessing.`,
    inputSchema: answerFaqSchema,
    isReadOnly: true,
    execute: ({ question }) => {
      const matches = matchFaqItems(question, FAQ_ITEMS, MAX_FAQ_MATCHES)
      return {
        question,
        matches: matches.map(({ item }) => ({ question: item.question, answer: item.answer })),
        // Stated explicitly so the agent does not have to infer intent from an
        // empty array and improvise an answer of its own.
        note:
          matches.length === 0
            ? 'The published FAQ does not cover this. Tell the visitor it is a question for the booked call rather than answering it yourself.'
            : 'These answers are published copy. Quote them rather than paraphrasing.',
      }
    },
    toResult: jsonResult,
  })
}

function getBookingLinkTool(): WebMcpTool {
  return defineWebMcpTool({
    name: 'getBookingLink',
    title: 'Get the meeting booking link',
    description: `The only way to start with ${SITE_NAME} is to book a call. Returns that link. There is no signup form, trial or pricing page to send someone to.`,
    inputSchema: noInputSchema,
    isReadOnly: true,
    execute: () => BOOKING_URL,
    toResult: (url) =>
      textResult(
        `Book a half-hour call at ${url}. It is used to describe the buyer you want to meet and see what the first month would look like.`,
      ),
  })
}

/** Every tool the marketing page registers, in the order an agent should read them. */
export function buildMarketingWebMcpTools(): readonly WebMcpTool[] {
  return [getProductOverviewTool(), answerFaqTool(), getBookingLinkTool()]
}
