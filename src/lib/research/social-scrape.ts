import { z } from 'zod'
import { env } from '@/lib/env'
import { fetchJson } from '@/lib/http/fetch-json'
import { AppError } from '@/lib/errors/app-error'
import { limitBrightdataSocialConcurrency } from './brightdata-limiter'

const DATASETS_BASE_URL = 'https://api.brightdata.com/datasets/v3'

// dataset_ids confirmed live against our own account 2026-08-14 — see
// docs/superpowers/specs/2026-08-14-social-scraping-design.md.
const LINKEDIN_POSTS_DATASET_ID = 'gd_lyy3tktm25m4avu764'
const X_POSTS_DATASET_ID = 'gd_lwxkxvnf1cynvib9co'

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${env.BRIGHTDATA_API_KEY}`, 'Content-Type': 'application/json' }
}

// Live testing 2026-08-14: LinkedIn ~49s, X ~30s for a single-profile
// discovery job. 180s leaves real headroom while still failing loudly
// instead of tying up a research task indefinitely.
const POLL_TIMEOUT_MS = 180_000
const POLL_INTERVAL_MS = 5_000

const triggerResponseSchema = z.object({ snapshot_id: z.string() })

// Bright Data's own docs disagree with themselves on this enum: the generic
// Monitor Progress reference (api-reference/scrapers/management-apis/
// monitor-progress) lists starting/running/ready/failed, while the
// per-dataset async guides (datasets/scrapers/linkedin/async-requests,
// .../chatgpt/async-requests) list collecting/digesting/ready/failed for the
// same GET /datasets/v3/progress/{id} endpoint. Accepting all of them is
// safe: pollUntilReady only special-cases 'ready' and 'failed' below, so any
// other value just means "keep polling," whichever vocabulary this job uses.
const progressResponseSchema = z.object({
  status: z.enum(['starting', 'running', 'collecting', 'digesting', 'ready', 'failed']),
  snapshot_id: z.string(),
})

export interface ScrapedPost {
  url: string
  text: string | null
  datePosted: string | null
}

// LinkedIn's text field is post_text; X's is description — accept either
// rather than guess, same pattern as apollo/client.ts's bulkMatchResponseSchema
// comment on matches-vs-people.
const postRecordSchema = z.object({
  url: z.string(),
  post_text: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  date_posted: z.string().nullable().optional(),
  error: z.string().optional(),
}).passthrough()

const snapshotResponseSchema = z.array(postRecordSchema)

async function triggerDiscovery(
  datasetId: string,
  discoverParams: Record<string, string>,
  profileUrl: string,
  extraInput: Record<string, unknown>,
): Promise<string> {
  const query = new URLSearchParams({ dataset_id: datasetId, ...discoverParams }).toString()
  const res = await fetchJson(
    `${DATASETS_BASE_URL}/trigger?${query}`,
    { method: 'POST', headers: authHeaders(), body: JSON.stringify({ input: [{ url: profileUrl, ...extraInput }] }) },
    triggerResponseSchema,
  )
  return res.snapshot_id
}

async function pollUntilReady(snapshotId: string): Promise<void> {
  const deadline = Date.now() + POLL_TIMEOUT_MS
  while (Date.now() < deadline) {
    const res = await fetchJson(
      `${DATASETS_BASE_URL}/progress/${snapshotId}`,
      { method: 'GET', headers: authHeaders() },
      progressResponseSchema,
    )
    if (res.status === 'ready') return
    if (res.status === 'failed') {
      throw new AppError('EXTERNAL_ERROR', 'Bright Data social scrape job failed', { snapshotId })
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }
  throw new AppError('EXTERNAL_TIMEOUT', 'Bright Data social scrape job did not finish in time', {
    snapshotId, timeoutMs: POLL_TIMEOUT_MS,
  })
}

async function downloadSnapshot(snapshotId: string): Promise<ScrapedPost[]> {
  const records = await fetchJson(
    `${DATASETS_BASE_URL}/snapshot/${snapshotId}?format=json`,
    { method: 'GET', headers: authHeaders() },
    snapshotResponseSchema,
  )
  // Bright Data reports per-record failures (e.g. a "Signup blocking page"
  // wall on one post) inline inside an otherwise-successful batch rather than
  // failing the whole job — confirmed live 2026-08-14. Drop only those rows.
  return records
    .filter((r) => !r.error)
    .map((r) => ({ url: r.url, text: r.post_text ?? r.description ?? null, datePosted: r.date_posted ?? null }))
}

// Gated by the social-discovery Bright Data limiter (a separate pool from
// search/scrape — see brightdata-limiter.ts's BRIGHTDATA_SOCIAL_MAX_CONCURRENT
// comment for why sharing one pool between the two was a bug) for the job's
// whole lifecycle (trigger through poll through download), not per HTTP call
// — a slot represents one in-flight discovery job, matching how Bright
// Data's own "too many running jobs for this dataset" 429 counts concurrency.
async function discoverPosts(
  datasetId: string,
  discoverParams: Record<string, string>,
  profileUrl: string,
  extraInput: Record<string, unknown> = {},
): Promise<ScrapedPost[]> {
  return limitBrightdataSocialConcurrency(async () => {
    const snapshotId = await triggerDiscovery(datasetId, discoverParams, profileUrl, extraInput)
    await pollUntilReady(snapshotId)
    return downloadSnapshot(snapshotId)
  })
}

/**
 * Posts authored by a specific person, via their Apollo-verified LinkedIn
 * URL. `only_authored_posts: true` is load-bearing — live testing 2026-08-14
 * found the default (false) surfaces other accounts' posts (reposts/related
 * content) mixed in with the target's own, which is exactly the cross-author
 * contamination this module exists to avoid.
 */
export async function discoverLinkedInPersonPosts(linkedinUrl: string): Promise<ScrapedPost[]> {
  return discoverPosts(
    LINKEDIN_POSTS_DATASET_ID,
    { type: 'discover_new', discover_by: 'profile_url' },
    linkedinUrl,
    { only_authored_posts: true },
  )
}

/**
 * Posts from a company's LinkedIn page.
 * NOTE: Bright Data's own docs assistant gave param names for this mode
 * (`discover_by=discover_new`+`discover_by_type=company_url`) inconsistent
 * with the profile_url pair confirmed live for discoverLinkedInPersonPosts —
 * confirm against the live Bright Data dashboard request-builder before
 * trusting this in production; this specific call was not independently
 * live-tested (see docs/superpowers/specs/2026-08-14-social-scraping-design.md).
 */
export async function discoverLinkedInCompanyPosts(companyUrl: string): Promise<ScrapedPost[]> {
  return discoverPosts(LINKEDIN_POSTS_DATASET_ID, { type: 'discover_new', discover_by: 'company_url' }, companyUrl)
}

/** Posts authored by a person's X/Twitter account, when Apollo has one on file. */
export async function discoverXPersonPosts(xUrl: string): Promise<ScrapedPost[]> {
  return discoverPosts(X_POSTS_DATASET_ID, { type: 'discover_new', discover_by: 'profile_url' }, xUrl)
}

/** Posts from a company's X/Twitter account — same discovery mode as a person's, X has no separate company dataset. */
export async function discoverXCompanyPosts(xUrl: string): Promise<ScrapedPost[]> {
  return discoverPosts(X_POSTS_DATASET_ID, { type: 'discover_new', discover_by: 'profile_url' }, xUrl)
}
