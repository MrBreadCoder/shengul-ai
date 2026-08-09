import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { logError } from '@/lib/events/log-event'
import { isAppError } from '@/lib/errors/app-error'
import type { Json } from '@/types/database'
import type { WebResearch } from './provider'

/**
 * Who this research run belongs to. Structurally satisfied by `LlmCallContext`
 * so `agent.ts` can pass the context it already has, without this module
 * depending on the LLM client.
 */
export interface ResearchToolContext {
  clientId: string
  caseId?: string | null
  actor: string
}

/**
 * Pulls the vendor's own status/response-body (or, for a network-level
 * failure, the underlying fetch error) out of `fetchJson`/`fetchText`'s
 * AppError context — dropped by `describeError` before it reaches the events
 * table, so without this the "errorMessage" an operator sees is just the
 * generic "HTTP 400"/"HTTP request failed" with no way to tell why. Only
 * `status` (a number), `body` (a string capped to 500 chars at the fetch
 * layer), and `cause` (the underlying error's own message) are ever set on
 * that context — never headers or the Authorization bearer token — so this
 * is safe to surface on the client's Logs tab.
 */
function externalErrorDetails(error: unknown): { status: Json; body: Json; cause: Json } {
  if (!isAppError(error)) return { status: null, body: null, cause: null }
  const { status, body, cause } = error.context
  return {
    status: typeof status === 'number' ? status : null,
    body: typeof body === 'string' && body.length > 0 ? body : null,
    cause: typeof cause === 'string' && cause.length > 0 ? cause : null,
  }
}

// The tool `execute` functions deliberately swallow provider failures and
// return an { error } result so a single bad search/scrape becomes a datum the
// model can route around, instead of throwing and killing the whole agent loop.
// Swallowing it in the loop is not a reason to hide it from the operator, so
// each failure is still recorded against the client before being downgraded.
export function buildResearchTools(
  deps: { research: WebResearch },
  context: ResearchToolContext,
): ToolSet {
  return {
    search: tool({
      description: 'Search the web and return the top result snippets (url, title, content).',
      inputSchema: z.object({ query: z.string().describe('The web search query') }),
      execute: async ({ query }: { query: string }) => {
        try {
          return await deps.research.search(query)
        } catch (error) {
          await logError({
            clientId: context.clientId,
            caseId: context.caseId ?? null,
            actor: context.actor,
            type: 'brightdata.search.failed',
            source: 'brightdata',
            error,
            payload: { query, ...externalErrorDetails(error) },
          })
          return { error: 'search failed' }
        }
      },
    }),
    scrape: tool({
      description: 'Fetch the full text of a specific result URL for deeper detail than a snippet.',
      inputSchema: z.object({ url: z.string().describe('The page URL to fetch') }),
      execute: async ({ url }: { url: string }) => {
        try {
          return await deps.research.scrape(url)
        } catch (error) {
          await logError({
            clientId: context.clientId,
            caseId: context.caseId ?? null,
            actor: context.actor,
            type: 'brightdata.scrape.failed',
            source: 'brightdata',
            error,
            payload: { url, ...externalErrorDetails(error) },
          })
          return { error: 'scrape failed' }
        }
      },
    }),
  }
}
