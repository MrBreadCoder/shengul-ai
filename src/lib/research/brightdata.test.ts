import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AppError } from '@/lib/errors/app-error'

const fetchJsonMock = vi.fn()
const fetchTextMock = vi.fn()
vi.mock('@/lib/http/fetch-json', () => ({
  fetchJson: (...args: unknown[]) => fetchJsonMock(...args),
}))
vi.mock('@/lib/http/fetch-text', () => ({
  fetchText: (...args: unknown[]) => fetchTextMock(...args),
}))
vi.mock('@/lib/env', () => ({
  env: { BRIGHTDATA_API_KEY: 'k', BRIGHTDATA_SCRAPE_ZONE: 'web_unlocker', BRIGHTDATA_SERP_ZONE: 'serp_api' },
}))

import { brightdataResearch } from './brightdata'
import { BRIGHTDATA_MAX_CONCURRENT } from './brightdata-limiter'

beforeEach(() => { fetchJsonMock.mockReset(); fetchTextMock.mockReset() })

// Each entry resolves only when its own `resolve()` is called, so the test
// can observe exactly how many fetchJson calls have started before any of
// them are allowed to finish.
function deferred(): { promise: Promise<{ organic: never[] }>; resolve: () => void } {
  let resolveFn: () => void
  const promise = new Promise<{ organic: never[] }>((resolve) => {
    resolveFn = () => resolve({ organic: [] })
  })
  return { promise, resolve: () => resolveFn() }
}

describe('brightdataResearch concurrency', () => {
  it('should cap concurrent search calls at BRIGHTDATA_MAX_CONCURRENT and queue the rest', async () => {
    const overflow = 2
    const total = BRIGHTDATA_MAX_CONCURRENT + overflow
    const deferreds = Array.from({ length: total }, () => deferred())
    let startedCount = 0
    fetchJsonMock.mockImplementation(() => {
      const d = deferreds[startedCount]!
      startedCount += 1
      return d.promise
    })

    const calls = Array.from({ length: total }, (_, i) => brightdataResearch.search(`query ${i}`))
    await vi.waitFor(() => expect(startedCount).toBe(BRIGHTDATA_MAX_CONCURRENT))

    // Release the first batch — this should free slots for the overflow calls.
    for (let i = 0; i < BRIGHTDATA_MAX_CONCURRENT; i += 1) deferreds[i]!.resolve()
    await vi.waitFor(() => expect(startedCount).toBe(total))

    for (let i = BRIGHTDATA_MAX_CONCURRENT; i < total; i += 1) deferreds[i]!.resolve()
    await Promise.all(calls)
  })
})

describe('brightdataResearch.search concurrency-and-retry interaction', () => {
  it('should release its concurrency slot during the retry backoff delay, letting a queued call start before the retry fires', async () => {
    vi.useFakeTimers()
    // Occupy every other slot with calls that hang until explicitly
    // resolved, so the one remaining slot is what's actually being tested.
    const hangingCount = BRIGHTDATA_MAX_CONCURRENT - 1
    const hangingDeferreds = Array.from({ length: hangingCount }, () => deferred())
    let callIndex = 0
    const queuedStarted = vi.fn()
    fetchJsonMock.mockImplementation(() => {
      const idx = callIndex
      callIndex += 1
      if (idx < hangingCount) return hangingDeferreds[idx]!.promise
      if (idx === hangingCount) return Promise.reject(new AppError('EXTERNAL_ERROR', 'boom'))
      queuedStarted()
      return Promise.resolve({ organic: [] })
    })

    // `limitBrightdataConcurrency` is a module-level singleton shared by
    // every test in this file — if this test's hanging calls are ever left
    // unresolved (e.g. the assertion below throws), those slots stay
    // permanently occupied and every later test's search()/scrape() call
    // hangs waiting for one, timing out. The finally block guarantees they
    // always get released, assertion outcome notwithstanding.
    const hangingCalls = Array.from({ length: hangingCount }, (_, i) => brightdataResearch.search(`hang ${i}`))
    const retryingCall = brightdataResearch.search('retry me')
    try {
      // Let the last slot's first attempt run and fail, scheduling its
      // RETRY_DELAY_MS backoff — without advancing past that delay.
      await vi.advanceTimersByTimeAsync(0)

      const queuedCall = brightdataResearch.search('queued')
      await vi.advanceTimersByTimeAsync(0)

      expect(queuedStarted).toHaveBeenCalledTimes(1)
      await queuedCall
    } finally {
      hangingDeferreds.forEach((d) => d.resolve())
      await vi.advanceTimersByTimeAsync(600) // fire the retry delay and let its second attempt resolve
      await Promise.allSettled(hangingCalls)
      await retryingCall.catch(() => {})
      vi.useRealTimers()
    }
  })
})

describe('brightdataResearch.search', () => {
  it('should map organic results to snippets when the API returns them', async () => {
    fetchJsonMock.mockResolvedValue({
      organic: [
        { link: 'https://acme.com', title: 'Acme', description: 'We do things' },
        { link: 'https://news.com/acme', title: 'Acme raises', description: 'Series B' },
      ],
    })
    const snippets = await brightdataResearch.search('Acme company')
    expect(snippets).toEqual([
      { url: 'https://acme.com', title: 'Acme', content: 'We do things' },
      { url: 'https://news.com/acme', title: 'Acme raises', content: 'Series B' },
    ])
  })

  it('should return an empty array when there are no organic results', async () => {
    fetchJsonMock.mockResolvedValue({ organic: [] })
    const snippets = await brightdataResearch.search('nothing here')
    expect(snippets).toEqual([])
  })

  it('should call the shared Bright Data request endpoint with the SERP zone and a brd_json google search url', async () => {
    fetchJsonMock.mockResolvedValue({ organic: [] })
    await brightdataResearch.search('Acme company')
    const [url, options] = fetchJsonMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.brightdata.com/request')
    const body = JSON.parse(options.body as string) as { zone: string; url: string; format: string }
    expect(body.zone).toBe('serp_api')
    expect(body.url).toBe('https://www.google.com/search?q=Acme%20company&brd_json=1')
    expect(body.format).toBe('raw')
  })

  it('should propagate AppError when every retry attempt fails', async () => {
    // search retries once (2 total attempts) — both must fail to see the error.
    fetchJsonMock
      .mockRejectedValueOnce(new AppError('EXTERNAL_ERROR', 'boom'))
      .mockRejectedValueOnce(new AppError('EXTERNAL_TIMEOUT', 'aborted'))
    await expect(brightdataResearch.search('x')).rejects.toBeInstanceOf(AppError)
    expect(fetchJsonMock).toHaveBeenCalledTimes(2)
  })

  it('should retry once and succeed when the first attempt is a transient failure', async () => {
    fetchJsonMock
      .mockRejectedValueOnce(new AppError('EXTERNAL_ERROR', 'Unexpected response shape'))
      .mockResolvedValueOnce({ organic: [{ link: 'https://acme.com', title: 'Acme', description: 'ok' }] })
    const snippets = await brightdataResearch.search('x')
    expect(snippets).toEqual([{ url: 'https://acme.com', title: 'Acme', content: 'ok' }])
    expect(fetchJsonMock).toHaveBeenCalledTimes(2)
  })
})

describe('brightdataResearch.scrape', () => {
  it('should return the page text when scrape succeeds', async () => {
    fetchTextMock.mockResolvedValue('# Acme\nWe build widgets for logistics teams.')
    const text = await brightdataResearch.scrape('https://acme.com/about')
    expect(text).toBe('# Acme\nWe build widgets for logistics teams.')
  })

  it('should call the shared Bright Data request endpoint with the scrape zone, not the SERP zone', async () => {
    fetchTextMock.mockResolvedValue('# Acme')
    await brightdataResearch.scrape('https://acme.com/about')
    const [url, options] = fetchTextMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.brightdata.com/request')
    const body = JSON.parse(options.body as string) as { zone: string; url: string }
    expect(body.zone).toBe('web_unlocker')
    expect(body.url).toBe('https://acme.com/about')
  })

  it('should truncate page text to the max length when the page is oversized', async () => {
    fetchTextMock.mockResolvedValue('x'.repeat(10_000))
    const text = await brightdataResearch.scrape('https://acme.com/huge')
    expect(text).toHaveLength(4_000)
  })

  it('should accept a custom maxChars ceiling and truncate to it instead of the default', async () => {
    fetchTextMock.mockResolvedValue('x'.repeat(50_000))
    const text = await brightdataResearch.scrape('https://acme.com/huge', 40_000)
    expect(text).toHaveLength(40_000)
  })

  it('should propagate AppError when every retry attempt fails', async () => {
    fetchTextMock
      .mockRejectedValueOnce(new AppError('EXTERNAL_ERROR', 'boom'))
      .mockRejectedValueOnce(new AppError('EXTERNAL_TIMEOUT', 'aborted'))
    await expect(brightdataResearch.scrape('https://acme.com')).rejects.toBeInstanceOf(AppError)
    expect(fetchTextMock).toHaveBeenCalledTimes(2)
  })

  it('should retry once and succeed when the first attempt is a transient failure', async () => {
    fetchTextMock
      .mockRejectedValueOnce(new AppError('EXTERNAL_TIMEOUT', 'aborted'))
      .mockResolvedValueOnce('# Acme\nWe build widgets.')
    const text = await brightdataResearch.scrape('https://acme.com')
    expect(text).toBe('# Acme\nWe build widgets.')
    expect(fetchTextMock).toHaveBeenCalledTimes(2)
  })
})
