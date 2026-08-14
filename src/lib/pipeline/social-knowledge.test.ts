import { describe, it, expect, vi, beforeEach } from 'vitest'

const discoverLinkedInPersonPostsMock = vi.fn()
const discoverLinkedInCompanyPostsMock = vi.fn()
const discoverXPersonPostsMock = vi.fn()
const discoverXCompanyPostsMock = vi.fn()
const logEventMock = vi.fn()

vi.mock('@/lib/research/social-scrape', () => ({
  discoverLinkedInPersonPosts: (...a: unknown[]) => discoverLinkedInPersonPostsMock(...a),
  discoverLinkedInCompanyPosts: (...a: unknown[]) => discoverLinkedInCompanyPostsMock(...a),
  discoverXPersonPosts: (...a: unknown[]) => discoverXPersonPostsMock(...a),
  discoverXCompanyPosts: (...a: unknown[]) => discoverXCompanyPostsMock(...a),
}))
vi.mock('@/lib/events/log-event', () => ({ logEventSafe: (...a: unknown[]) => logEventMock(...a) }))

import { collectSocialKnowledge } from './social-knowledge'

const NOW = new Date('2026-08-14T00:00:00Z')
const context = { clientId: 'c1', caseId: 'case1' }

beforeEach(() => {
  discoverLinkedInPersonPostsMock.mockReset()
  discoverLinkedInCompanyPostsMock.mockReset()
  discoverXPersonPostsMock.mockReset()
  discoverXCompanyPostsMock.mockReset()
  logEventMock.mockReset()
})

describe('collectSocialKnowledge', () => {
  it('should return an empty array and make zero calls when no social targets are given', async () => {
    const result = await collectSocialKnowledge(context, { linkedinUrl: null, twitterUrl: null }, [], NOW)
    expect(result).toEqual([])
    expect(discoverLinkedInPersonPostsMock).not.toHaveBeenCalled()
    expect(discoverLinkedInCompanyPostsMock).not.toHaveBeenCalled()
    expect(discoverXPersonPostsMock).not.toHaveBeenCalled()
    expect(discoverXCompanyPostsMock).not.toHaveBeenCalled()
  })

  it('should tag company posts with leadId: null', async () => {
    discoverLinkedInCompanyPostsMock.mockResolvedValue([
      { url: 'https://linkedin.com/posts/co1', text: 'We shipped a new feature', datePosted: '2026-08-10T00:00:00Z' },
    ])
    const result = await collectSocialKnowledge(context, { linkedinUrl: 'https://linkedin.com/company/acme', twitterUrl: null }, [], NOW)
    expect(result).toEqual([{
      kind: 'news', content: 'We shipped a new feature', sourceUrl: 'https://linkedin.com/posts/co1',
      citation: 'LinkedIn post, 2026-08-10', leadId: null, eventDate: '2026-08-10T00:00:00Z',
    }])
  })

  it('should tag a person post with that person\'s leadId', async () => {
    discoverLinkedInPersonPostsMock.mockResolvedValue([
      { url: 'https://linkedin.com/posts/p1', text: 'Excited to announce a promotion', datePosted: '2026-08-12T00:00:00Z' },
    ])
    const result = await collectSocialKnowledge(
      context,
      { linkedinUrl: null, twitterUrl: null },
      [{ leadId: 'lead-a', linkedinUrl: 'https://linkedin.com/in/janedoe', twitterUrl: null }],
      NOW,
    )
    expect(result).toEqual([{
      kind: 'news', content: 'Excited to announce a promotion', sourceUrl: 'https://linkedin.com/posts/p1',
      citation: 'LinkedIn post, 2026-08-12', leadId: 'lead-a', eventDate: '2026-08-12T00:00:00Z',
    }])
  })

  it('should drop a post older than 90 days', async () => {
    discoverLinkedInCompanyPostsMock.mockResolvedValue([
      { url: 'https://linkedin.com/posts/old', text: 'old news', datePosted: '2026-01-01T00:00:00Z' }, // ~225 days before NOW
    ])
    const result = await collectSocialKnowledge(context, { linkedinUrl: 'https://linkedin.com/company/acme', twitterUrl: null }, [], NOW)
    expect(result).toEqual([])
  })

  it('should keep a post exactly at the 90-day boundary and drop one just past it', async () => {
    discoverLinkedInCompanyPostsMock.mockResolvedValue([
      { url: 'https://linkedin.com/posts/boundary', text: 'right at 90 days', datePosted: '2026-05-16T00:00:00Z' }, // exactly 90 days before NOW
      { url: 'https://linkedin.com/posts/past', text: 'just past 90 days', datePosted: '2026-05-15T00:00:00Z' }, // 91 days before NOW
    ])
    const result = await collectSocialKnowledge(context, { linkedinUrl: 'https://linkedin.com/company/acme', twitterUrl: null }, [], NOW)
    expect(result).toHaveLength(1)
    expect(result[0]!.sourceUrl).toBe('https://linkedin.com/posts/boundary')
  })

  it('should drop a post with no text or no datePosted', async () => {
    discoverLinkedInCompanyPostsMock.mockResolvedValue([
      { url: 'https://linkedin.com/posts/no-text', text: null, datePosted: '2026-08-10T00:00:00Z' },
      { url: 'https://linkedin.com/posts/no-date', text: 'has text', datePosted: null },
    ])
    const result = await collectSocialKnowledge(context, { linkedinUrl: 'https://linkedin.com/company/acme', twitterUrl: null }, [], NOW)
    expect(result).toEqual([])
  })

  it('should query both LinkedIn and X for the same lead when both URLs are present', async () => {
    discoverLinkedInPersonPostsMock.mockResolvedValue([])
    discoverXPersonPostsMock.mockResolvedValue([
      { url: 'https://x.com/janedoe/status/1', text: 'a tweet', datePosted: '2026-08-13T00:00:00Z' },
    ])
    const result = await collectSocialKnowledge(
      context,
      { linkedinUrl: null, twitterUrl: null },
      [{ leadId: 'lead-a', linkedinUrl: 'https://linkedin.com/in/janedoe', twitterUrl: 'https://x.com/janedoe' }],
      NOW,
    )
    expect(discoverLinkedInPersonPostsMock).toHaveBeenCalledWith('https://linkedin.com/in/janedoe')
    expect(discoverXPersonPostsMock).toHaveBeenCalledWith('https://x.com/janedoe')
    expect(result).toEqual([expect.objectContaining({ sourceUrl: 'https://x.com/janedoe/status/1', leadId: 'lead-a' })])
  })

  it('should log and continue (return empty for that source) when one source throws', async () => {
    discoverLinkedInCompanyPostsMock.mockRejectedValue(new Error('bright data down'))
    discoverXCompanyPostsMock.mockResolvedValue([
      { url: 'https://x.com/acme/status/1', text: 'still works', datePosted: '2026-08-10T00:00:00Z' },
    ])
    const result = await collectSocialKnowledge(
      context,
      { linkedinUrl: 'https://linkedin.com/company/acme', twitterUrl: 'https://x.com/acme' },
      [],
      NOW,
    )
    expect(result).toEqual([expect.objectContaining({ sourceUrl: 'https://x.com/acme/status/1' })])
    expect(logEventMock).toHaveBeenCalledWith(expect.objectContaining({
      type: 'pipeline.research.social_scrape_failed',
      payload: expect.objectContaining({ source: 'linkedin_company' }),
    }))
  })
})
