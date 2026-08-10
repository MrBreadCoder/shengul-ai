import { z } from 'zod'
import { env } from '@/lib/env'
import { AppError } from '@/lib/errors/app-error'
import { fetchJson } from '@/lib/http/fetch-json'
import { fetchText } from '@/lib/http/fetch-text'
import type { WebResearch, WebSnippet } from './provider'

// Both SERP and Web Unlocker requests go through the same Bright Data proxy
// endpoint — they're distinguished only by which `zone` is passed in the body.
const BRIGHTDATA_REQUEST_URL = 'https://api.brightdata.com/request'
const MAX_SNIPPETS = 8
// Trimmed 2026-08-10 (6,000 → 4,000) for cost: every scraped page's text
// accumulates into every later step's prompt in the same tool loop, so this
// compounds across GATHER_STEPS — see the same day's roadmap entries on
// research-agent token spend.
const MAX_SCRAPE_CHARS = 4_000
// Raised 2026-08-10 (30s/40s → 45s/60s) alongside TOOL_LOOP_TIMEOUT_MS in
// llm/client.ts — see that constant's comment for the full worst-case math.
const TIMEOUT_MS = 45_000
const SCRAPE_TIMEOUT_MS = 60_000

// A live test (2026-08-10 roadmap entry) found both of these repeatedly and
// transiently: "Unexpected response shape" (Bright Data occasionally returns
// a 200 with an empty/malformed body — the same shape an IP-block produces,
// but this recurred after that block was lifted, so it's a broader upstream
// flake) and "aborted" (the request just runs past TIMEOUT_MS/SCRAPE_TIMEOUT_MS
// under a slow proxy hop). Manually retrying the *exact same* failed query
// moments later succeeded both times — proof this is transient, not a
// config/auth problem — so one retry buys real reliability here. Capped at 2
// total attempts to keep the worst case bounded (this eats into the shared
// TOOL_LOOP_TIMEOUT_MS budget in llm/client.ts).
const MAX_ATTEMPTS = 2
const RETRY_DELAY_MS = 500

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Retries any failure from `operation` (both observed failure modes surface
// as AppError — EXTERNAL_ERROR for the malformed-response case, EXTERNAL_TIMEOUT
// for the abort case) up to MAX_ATTEMPTS times, with a short fixed delay so a
// momentarily-struggling proxy zone isn't hit again immediately. Callers still
// see the final attempt's error if every attempt fails — this only masks a
// transient blip, never a persistent failure.
async function withRetry<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      lastError = error
      if (attempt < MAX_ATTEMPTS) await delay(RETRY_DELAY_MS)
    }
  }
  throw lastError
}

const serpResponseSchema = z.object({
  organic: z
    .array(
      z.object({
        link: z.string(),
        title: z.string().optional(),
        description: z.string().optional(),
      }),
    )
    .optional(),
})

export const brightdataResearch: WebResearch = {
  async search(query: string): Promise<WebSnippet[]> {
    let response: z.infer<typeof serpResponseSchema>
    try {
      // fetchJson enforces the timeout itself (AbortController) and clears its
      // own timer — no outer Promise.race needed.
      // brd_json=1 asks Bright Data's SERP parser for structured JSON (the
      // `serpResponseSchema` shape below) instead of raw Google HTML.
      const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&brd_json=1`
      response = await withRetry(() =>
        fetchJson(
          BRIGHTDATA_REQUEST_URL,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${env.BRIGHTDATA_API_KEY}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ zone: env.BRIGHTDATA_SERP_ZONE, url: searchUrl, format: 'raw' }),
          },
          serpResponseSchema,
          TIMEOUT_MS,
        ),
      )
    } catch (cause) {
      if (cause instanceof AppError) throw cause
      throw new AppError('EXTERNAL_ERROR', 'Brightdata search failed', {
        query,
        cause: cause instanceof Error ? cause.message : String(cause),
      })
    }
    const organic = response.organic ?? []
    return organic.slice(0, MAX_SNIPPETS).map((r) => ({
      url: r.link,
      title: r.title ?? r.link,
      content: r.description ?? '',
    }))
  },

  async scrape(url: string, maxChars: number = MAX_SCRAPE_CHARS): Promise<string> {
    try {
      // Web Unlocker returns the page as markdown when data_format=markdown,
      // which is far cheaper to feed to the model than raw HTML.
      const body = await withRetry(() =>
        fetchText(
          BRIGHTDATA_REQUEST_URL,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${env.BRIGHTDATA_API_KEY}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              zone: env.BRIGHTDATA_SCRAPE_ZONE,
              url,
              format: 'raw',
              data_format: 'markdown',
            }),
          },
          SCRAPE_TIMEOUT_MS,
        ),
      )
      return body.slice(0, maxChars)
    } catch (cause) {
      if (cause instanceof AppError) throw cause
      throw new AppError('EXTERNAL_ERROR', 'Brightdata scrape failed', {
        url,
        cause: cause instanceof Error ? cause.message : String(cause),
      })
    }
  },
}
