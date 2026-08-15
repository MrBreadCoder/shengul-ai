import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockFetchJson = vi.hoisted(() => vi.fn())
vi.mock('@/lib/http/fetch-json', () => ({ fetchJson: mockFetchJson }))
vi.mock('@/lib/env', () => ({ env: { BRIGHTDATA_API_KEY: 'test-brightdata-key' } }))

import { discoverLinkedInPersonPosts, discoverLinkedInCompanyPosts, discoverXPersonPosts, discoverXCompanyPosts } from './social-scrape'
import { BRIGHTDATA_MAX_CONCURRENT } from './brightdata-limiter'

beforeEach(() => { mockFetchJson.mockReset() })

describe('discoverLinkedInPersonPosts', () => {
  it('should trigger, poll until ready, and download mapped posts', async () => {
    mockFetchJson
      .mockResolvedValueOnce({ snapshot_id: 'snap1' }) // trigger
      .mockResolvedValueOnce({ status: 'ready', snapshot_id: 'snap1' }) // progress
      .mockResolvedValueOnce([ // snapshot
        { url: 'https://linkedin.com/posts/1', post_text: 'Hiring engineers!', date_posted: '2026-08-10T00:00:00Z' },
      ])

    const posts = await discoverLinkedInPersonPosts('https://www.linkedin.com/in/janedoe/')

    expect(posts).toEqual([{ url: 'https://linkedin.com/posts/1', text: 'Hiring engineers!', datePosted: '2026-08-10T00:00:00Z' }])
  })

  it('should call trigger with only_authored_posts:true and the LinkedIn posts dataset_id', async () => {
    mockFetchJson
      .mockResolvedValueOnce({ snapshot_id: 'snap1' })
      .mockResolvedValueOnce({ status: 'ready', snapshot_id: 'snap1' })
      .mockResolvedValueOnce([])

    await discoverLinkedInPersonPosts('https://www.linkedin.com/in/janedoe/')

    const [url, options] = mockFetchJson.mock.calls[0]!
    expect(url).toContain('dataset_id=gd_lyy3tktm25m4avu764')
    expect(url).toContain('type=discover_new')
    expect(url).toContain('discover_by=profile_url')
    const body = JSON.parse((options as RequestInit).body as string)
    expect(body.input).toEqual([{ url: 'https://www.linkedin.com/in/janedoe/', only_authored_posts: true }])
  })

  it('should drop records that report an inline error without failing the whole call', async () => {
    mockFetchJson
      .mockResolvedValueOnce({ snapshot_id: 'snap1' })
      .mockResolvedValueOnce({ status: 'ready', snapshot_id: 'snap1' })
      .mockResolvedValueOnce([
        { url: 'https://linkedin.com/posts/bad', error: 'There is a Signup blocking page' },
        { url: 'https://linkedin.com/posts/good', post_text: 'ok', date_posted: '2026-08-10T00:00:00Z' },
      ])

    const posts = await discoverLinkedInPersonPosts('https://www.linkedin.com/in/janedoe/')

    expect(posts).toEqual([{ url: 'https://linkedin.com/posts/good', text: 'ok', datePosted: '2026-08-10T00:00:00Z' }])
  })

  it('should throw AppError EXTERNAL_ERROR when the job status is failed', async () => {
    mockFetchJson
      .mockResolvedValueOnce({ snapshot_id: 'snap1' })
      .mockResolvedValueOnce({ status: 'failed', snapshot_id: 'snap1' })

    await expect(discoverLinkedInPersonPosts('https://www.linkedin.com/in/janedoe/'))
      .rejects.toMatchObject({ code: 'EXTERNAL_ERROR' })
  })
})

describe('discoverLinkedInCompanyPosts', () => {
  it('should call trigger with discover_by=company_url and the LinkedIn posts dataset_id', async () => {
    mockFetchJson
      .mockResolvedValueOnce({ snapshot_id: 'snap2' })
      .mockResolvedValueOnce({ status: 'ready', snapshot_id: 'snap2' })
      .mockResolvedValueOnce([])

    await discoverLinkedInCompanyPosts('https://www.linkedin.com/company/acme/')

    const [url, options] = mockFetchJson.mock.calls[0]!
    expect(url).toContain('dataset_id=gd_lyy3tktm25m4avu764')
    expect(url).toContain('discover_by=company_url')
    const body = JSON.parse((options as RequestInit).body as string)
    expect(body.input).toEqual([{ url: 'https://www.linkedin.com/company/acme/' }])
  })
})

describe('discoverXPersonPosts / discoverXCompanyPosts', () => {
  it('should call trigger with the X posts dataset_id and profile_url discovery for a person', async () => {
    mockFetchJson
      .mockResolvedValueOnce({ snapshot_id: 'snap3' })
      .mockResolvedValueOnce({ status: 'ready', snapshot_id: 'snap3' })
      .mockResolvedValueOnce([{ url: 'https://x.com/janedoe/status/1', description: 'a tweet', date_posted: '2026-08-13T00:00:00Z' }])

    const posts = await discoverXPersonPosts('https://x.com/janedoe')

    const [url] = mockFetchJson.mock.calls[0]!
    expect(url).toContain('dataset_id=gd_lwxkxvnf1cynvib9co')
    expect(url).toContain('discover_by=profile_url')
    expect(posts).toEqual([{ url: 'https://x.com/janedoe/status/1', text: 'a tweet', datePosted: '2026-08-13T00:00:00Z' }])
  })

  it('should map the X `description` field to text (X uses a different field name than LinkedIn)', async () => {
    mockFetchJson
      .mockResolvedValueOnce({ snapshot_id: 'snap4' })
      .mockResolvedValueOnce({ status: 'ready', snapshot_id: 'snap4' })
      .mockResolvedValueOnce([{ url: 'https://x.com/acme/status/2', description: 'company news', date_posted: '2026-08-12T00:00:00Z' }])

    const posts = await discoverXCompanyPosts('https://x.com/acme')

    expect(posts).toEqual([{ url: 'https://x.com/acme/status/2', text: 'company news', datePosted: '2026-08-12T00:00:00Z' }])
  })
})

describe('polling behavior', () => {
  it('should poll again when status is running, then succeed once ready', async () => {
    // Fake timers: the real POLL_INTERVAL_MS (5s) between polls would race
    // vitest's default 5s test timeout otherwise — not a long-running test,
    // just a real wait that happens to sit right at the timeout boundary.
    vi.useFakeTimers()
    mockFetchJson
      .mockResolvedValueOnce({ snapshot_id: 'snap5' })
      .mockResolvedValueOnce({ status: 'running', snapshot_id: 'snap5' })
      .mockResolvedValueOnce({ status: 'ready', snapshot_id: 'snap5' })
      .mockResolvedValueOnce([{ url: 'https://linkedin.com/posts/1', post_text: 'ok', date_posted: '2026-08-10T00:00:00Z' }])

    const resultPromise = discoverLinkedInPersonPosts('https://www.linkedin.com/in/janedoe/')
    await vi.advanceTimersByTimeAsync(5_000) // one POLL_INTERVAL_MS wait between the "running" and "ready" polls
    const posts = await resultPromise

    expect(posts).toHaveLength(1)
    expect(mockFetchJson).toHaveBeenCalledTimes(4) // trigger + 2 progress polls + snapshot
    vi.useRealTimers()
  })

  it('should poll through the collecting/digesting status vocabulary, then succeed once ready', async () => {
    // Bright Data's per-dataset async guides document collecting/digesting
    // instead of starting/running for this same endpoint — see the comment
    // on progressResponseSchema in social-scrape.ts.
    vi.useFakeTimers()
    mockFetchJson
      .mockResolvedValueOnce({ snapshot_id: 'snap7' })
      .mockResolvedValueOnce({ status: 'collecting', snapshot_id: 'snap7' })
      .mockResolvedValueOnce({ status: 'digesting', snapshot_id: 'snap7' })
      .mockResolvedValueOnce({ status: 'ready', snapshot_id: 'snap7' })
      .mockResolvedValueOnce([{ url: 'https://linkedin.com/posts/1', post_text: 'ok', date_posted: '2026-08-10T00:00:00Z' }])

    const resultPromise = discoverLinkedInPersonPosts('https://www.linkedin.com/in/janedoe/')
    await vi.advanceTimersByTimeAsync(5_000) // collecting -> digesting
    await vi.advanceTimersByTimeAsync(5_000) // digesting -> ready
    const posts = await resultPromise

    expect(posts).toHaveLength(1)
    expect(mockFetchJson).toHaveBeenCalledTimes(5) // trigger + 3 progress polls + snapshot
    vi.useRealTimers()
  })

  it('should throw AppError EXTERNAL_TIMEOUT when the job never reaches ready or failed', async () => {
    vi.useFakeTimers()
    mockFetchJson
      .mockResolvedValueOnce({ snapshot_id: 'snap6' })
      .mockResolvedValue({ status: 'running', snapshot_id: 'snap6' }) // every subsequent poll stays running

    const resultPromise = discoverLinkedInPersonPosts('https://www.linkedin.com/in/janedoe/')
    // Attach the rejection handler before advancing time — the rejection can
    // land mid-loop below, and an unattached rejection triggers Node's
    // unhandledRejection warning even though it's handled a line later.
    const assertion = expect(resultPromise).rejects.toMatchObject({ code: 'EXTERNAL_TIMEOUT' })
    // Advance past POLL_TIMEOUT_MS (180_000ms) in POLL_INTERVAL_MS (5_000ms) steps.
    for (let elapsed = 0; elapsed <= 180_000; elapsed += 5_000) {
      await vi.advanceTimersByTimeAsync(5_000)
    }

    await assertion
    vi.useRealTimers()
  })
})

describe('discovery job concurrency', () => {
  it('should cap concurrent discovery jobs at BRIGHTDATA_MAX_CONCURRENT and queue the rest', async () => {
    const overflow = 2
    const total = BRIGHTDATA_MAX_CONCURRENT + overflow
    const profileUrls = Array.from({ length: total }, (_, i) => `https://www.linkedin.com/in/person-${i}/`)
    const startedProfiles: string[] = []
    const triggerDeferreds = new Map<string, () => void>()
    const triggerPromises = new Map<string, Promise<{ snapshot_id: string }>>()

    for (const profileUrl of profileUrls) {
      let resolveFn: () => void = () => {}
      const promise = new Promise<{ snapshot_id: string }>((resolve) => {
        resolveFn = () => resolve({ snapshot_id: `snap-${profileUrl}` })
      })
      triggerDeferreds.set(profileUrl, resolveFn)
      triggerPromises.set(profileUrl, promise)
    }

    mockFetchJson.mockImplementation((url: string, options: RequestInit) => {
      if (url.includes('/trigger?')) {
        const body = JSON.parse(options.body as string) as { input: Array<{ url: string }> }
        const profileUrl = body.input[0]!.url
        startedProfiles.push(profileUrl)
        return triggerPromises.get(profileUrl)
      }
      if (url.includes('/progress/')) {
        return Promise.resolve({ status: 'ready', snapshot_id: 'irrelevant-in-this-test' })
      }
      return Promise.resolve([]) // snapshot download
    })

    const calls = profileUrls.map((profileUrl) => discoverLinkedInPersonPosts(profileUrl))
    await vi.waitFor(() => expect(startedProfiles).toHaveLength(BRIGHTDATA_MAX_CONCURRENT))

    for (const profileUrl of profileUrls.slice(0, BRIGHTDATA_MAX_CONCURRENT)) triggerDeferreds.get(profileUrl)!()
    await vi.waitFor(() => expect(startedProfiles).toHaveLength(total))

    for (const profileUrl of profileUrls.slice(BRIGHTDATA_MAX_CONCURRENT)) triggerDeferreds.get(profileUrl)!()
    await Promise.all(calls)
  })
})
