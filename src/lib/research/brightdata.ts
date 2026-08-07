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
const MAX_SCRAPE_CHARS = 6_000
const TIMEOUT_MS = 8000
const SCRAPE_TIMEOUT_MS = 12_000

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
      response = await fetchJson(
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
      const body = await fetchText(
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
