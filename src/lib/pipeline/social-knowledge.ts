import { discoverLinkedInPersonPosts, discoverLinkedInCompanyPosts, discoverXPersonPosts, discoverXCompanyPosts, type ScrapedPost } from '@/lib/research/social-scrape'
import { logEventSafe } from '@/lib/events/log-event'
import { isAppError } from '@/lib/errors/app-error'

// Posts older than this are dropped entirely, not deprioritized — an opener
// referencing a "recent" post that's actually 4 months old reads worse than
// no personalization at all. See docs/superpowers/specs/2026-08-14-social-scraping-design.md.
const MAX_POST_AGE_DAYS = 90
const MAX_CONTENT_CHARS = 600

// X post scraping disabled 2026-08-19 — kill switch, not a removal. Flip
// back to true to re-enable; the discoverX*Posts call sites below stay
// wired up behind this flag.
const X_SCRAPING_ENABLED = false

export interface SocialKnowledgeCandidate {
  kind: 'news'
  content: string
  sourceUrl: string
  citation: string
  leadId: string | null
  eventDate: string
}

export interface PersonSocialTarget {
  leadId: string
  linkedinUrl: string | null
  twitterUrl: string | null
}

export interface CompanySocialTarget {
  linkedinUrl: string | null
  twitterUrl: string | null
}

function withinCutoff(datePosted: string, now: Date): boolean {
  const posted = new Date(datePosted)
  if (Number.isNaN(posted.getTime())) return false
  const ageDays = (now.getTime() - posted.getTime()) / (1000 * 60 * 60 * 24)
  // ageDays >= 0 rejects a future-dated post outright (clock skew or bad
  // upstream data) rather than silently treating it as maximally "fresh."
  return ageDays >= 0 && ageDays <= MAX_POST_AGE_DAYS
}

function toCandidates(posts: ScrapedPost[], leadId: string | null, platform: 'LinkedIn' | 'X', now: Date): SocialKnowledgeCandidate[] {
  const candidates: SocialKnowledgeCandidate[] = []
  for (const post of posts) {
    if (!post.text || !post.datePosted) continue
    if (!withinCutoff(post.datePosted, now)) continue
    candidates.push({
      kind: 'news',
      content: post.text.slice(0, MAX_CONTENT_CHARS),
      sourceUrl: post.url,
      citation: `${platform} post, ${post.datePosted.slice(0, 10)}`,
      leadId,
      eventDate: post.datePosted,
    })
  }
  return candidates
}

// One failed source (a LinkedIn timeout, an X job that errors) never fails
// the case — matches runResearchForCase's existing "one agent failure is
// logged and dropped, not fatal" stance.
async function safeDiscover(
  fn: () => Promise<ScrapedPost[]>,
  context: { clientId: string; caseId: string; source: string },
): Promise<ScrapedPost[]> {
  try {
    return await fn()
  } catch (error) {
    await logEventSafe({
      clientId: context.clientId,
      caseId: context.caseId,
      actor: 'social_scrape',
      type: 'pipeline.research.social_scrape_failed',
      payload: { source: context.source, errorCode: isAppError(error) ? error.code : 'EXTERNAL_ERROR' },
    })
    return []
  }
}

export async function collectSocialKnowledge(
  context: { clientId: string; caseId: string },
  company: CompanySocialTarget,
  people: PersonSocialTarget[],
  now: Date = new Date(),
): Promise<SocialKnowledgeCandidate[]> {
  const tasks: Promise<SocialKnowledgeCandidate[]>[] = []

  if (company.linkedinUrl) {
    const url = company.linkedinUrl
    tasks.push(
      safeDiscover(() => discoverLinkedInCompanyPosts(url), { ...context, source: 'linkedin_company' })
        .then((posts) => toCandidates(posts, null, 'LinkedIn', now)),
    )
  }
  if (X_SCRAPING_ENABLED && company.twitterUrl) {
    const url = company.twitterUrl
    tasks.push(
      safeDiscover(() => discoverXCompanyPosts(url), { ...context, source: 'x_company' })
        .then((posts) => toCandidates(posts, null, 'X', now)),
    )
  }
  for (const person of people) {
    if (person.linkedinUrl) {
      const url = person.linkedinUrl
      tasks.push(
        safeDiscover(() => discoverLinkedInPersonPosts(url), { ...context, source: 'linkedin_person' })
          .then((posts) => toCandidates(posts, person.leadId, 'LinkedIn', now)),
      )
    }
    if (X_SCRAPING_ENABLED && person.twitterUrl) {
      const url = person.twitterUrl
      tasks.push(
        safeDiscover(() => discoverXPersonPosts(url), { ...context, source: 'x_person' })
          .then((posts) => toCandidates(posts, person.leadId, 'X', now)),
      )
    }
  }

  const results = await Promise.all(tasks)
  return results.flat()
}
