import { describe, it, expect, vi } from 'vitest'
import {
  limitBrightdataConcurrency,
  limitBrightdataSocialConcurrency,
  BRIGHTDATA_MAX_CONCURRENT,
  BRIGHTDATA_SOCIAL_MAX_CONCURRENT,
} from './brightdata-limiter'

describe('brightdata concurrency pools', () => {
  it('should expose a positive concurrency cap for the social-discovery pool, independent of the search/scrape cap', () => {
    expect(BRIGHTDATA_SOCIAL_MAX_CONCURRENT).toBeGreaterThan(0)
    expect(BRIGHTDATA_MAX_CONCURRENT).toBeGreaterThan(0)
  })

  it('should let a search/scrape call run immediately even when the social-discovery pool is fully saturated', async () => {
    // Saturate every social-discovery slot with tasks that never resolve on
    // their own — models a burst of long-running LinkedIn/X discovery jobs
    // (each holds its slot for up to POLL_TIMEOUT_MS, minutes at a time).
    const socialGates: Array<() => void> = []
    const socialStarted = vi.fn()
    // Promises retained (not `void`-discarded) so the finally block below can
    // await them after releasing their gates — both limiters here are
    // module-level singletons shared by every test in this file, so a task
    // left pending after a failed assertion would permanently occupy a slot
    // and hang every later test that needs one.
    const socialTasks = Array.from({ length: BRIGHTDATA_SOCIAL_MAX_CONCURRENT }, () =>
      limitBrightdataSocialConcurrency(
        () =>
          new Promise<void>((resolve) => {
            socialStarted()
            socialGates.push(resolve)
          }),
      ),
    )
    try {
      await Promise.resolve()
      await Promise.resolve()
      expect(socialStarted).toHaveBeenCalledTimes(BRIGHTDATA_SOCIAL_MAX_CONCURRENT)

      // A fast search/scrape call made while the social pool is fully occupied
      // must still start right away — the two pools must not share capacity.
      const searchStarted = vi.fn()
      await limitBrightdataConcurrency(async () => {
        searchStarted()
        return 'ok'
      })
      expect(searchStarted).toHaveBeenCalledTimes(1)
    } finally {
      socialGates.forEach((resolve) => resolve())
      await Promise.allSettled(socialTasks)
    }
  })

  it('should let a social-discovery call run immediately even when the search/scrape pool is fully saturated', async () => {
    const searchGates: Array<() => void> = []
    const searchStarted = vi.fn()
    const searchTasks = Array.from({ length: BRIGHTDATA_MAX_CONCURRENT }, () =>
      limitBrightdataConcurrency(
        () =>
          new Promise<void>((resolve) => {
            searchStarted()
            searchGates.push(resolve)
          }),
      ),
    )
    try {
      await Promise.resolve()
      await Promise.resolve()
      expect(searchStarted).toHaveBeenCalledTimes(BRIGHTDATA_MAX_CONCURRENT)

      const socialStarted = vi.fn()
      await limitBrightdataSocialConcurrency(async () => {
        socialStarted()
        return 'ok'
      })
      expect(socialStarted).toHaveBeenCalledTimes(1)
    } finally {
      searchGates.forEach((resolve) => resolve())
      await Promise.allSettled(searchTasks)
    }
  })
})
