/**
 * Bounds how many async operations from `limit(fn)` run at once. Callers
 * beyond `maxConcurrent` queue in FIFO order and start as soon as an earlier
 * one finishes (success or throw) — nobody waits forever, they just wait
 * their turn. Generic and dependency-free so it can gate any external call,
 * not just Bright Data (see src/lib/research/brightdata-limiter.ts for that
 * wiring).
 */
export function createConcurrencyLimiter(maxConcurrent: number): <T>(fn: () => Promise<T>) => Promise<T> {
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
    throw new RangeError('maxConcurrent must be a positive integer')
  }

  let active = 0
  const queue: Array<() => void> = []

  function acquire(): Promise<void> {
    if (active < maxConcurrent) {
      active += 1
      return Promise.resolve()
    }
    return new Promise((resolve) => queue.push(resolve))
  }

  function release(): void {
    const next = queue.shift()
    if (next) {
      // Hand the freed slot straight to the next waiter — active stays the
      // same (one task's slot becomes another's), so this must not
      // decrement active before running next().
      next()
      return
    }
    active -= 1
  }

  return async function limit<T>(fn: () => Promise<T>): Promise<T> {
    await acquire()
    try {
      return await fn()
    } finally {
      release()
    }
  }
}
