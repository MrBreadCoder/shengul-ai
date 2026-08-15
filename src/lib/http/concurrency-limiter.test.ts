import { describe, it, expect, vi } from 'vitest'
import { createConcurrencyLimiter } from './concurrency-limiter'

// A controllable async task: stays pending until `resolve` is called, and
// records itself as active/inactive around the await so tests can assert on
// how many tasks were running at once.
function deferredTask(activeLog: number[], active: { count: number }): { run: () => Promise<string>; resolve: () => void } {
  let resolveFn: () => void
  const gate = new Promise<void>((resolve) => { resolveFn = resolve })
  return {
    run: async () => {
      active.count += 1
      activeLog.push(active.count)
      await gate
      active.count -= 1
      return 'done'
    },
    resolve: () => resolveFn(),
  }
}

describe('createConcurrencyLimiter', () => {
  it('should throw RangeError when maxConcurrent is zero or negative', () => {
    expect(() => createConcurrencyLimiter(0)).toThrow(RangeError)
    expect(() => createConcurrencyLimiter(-1)).toThrow(RangeError)
  })

  it('should throw RangeError when maxConcurrent is not an integer', () => {
    expect(() => createConcurrencyLimiter(1.5)).toThrow(RangeError)
  })

  it('should run a task immediately when under the limit', async () => {
    const limit = createConcurrencyLimiter(2)
    const result = await limit(async () => 'value')
    expect(result).toBe('value')
  })

  it('should never let more than maxConcurrent tasks run at the same time', async () => {
    const limit = createConcurrencyLimiter(2)
    const active = { count: 0 }
    const activeLog: number[] = []
    const tasks = [
      deferredTask(activeLog, active),
      deferredTask(activeLog, active),
      deferredTask(activeLog, active),
    ]

    const results = tasks.map((t) => limit(t.run))
    // Let all three attempt to start; only 2 should have entered the "active" section.
    await Promise.resolve()
    await Promise.resolve()
    expect(active.count).toBe(2)

    tasks.forEach((t) => t.resolve())
    await Promise.all(results)

    expect(Math.max(...activeLog)).toBeLessThanOrEqual(2)
  })

  it('should start a queued task once an earlier one finishes', async () => {
    const limit = createConcurrencyLimiter(1)
    const first = deferredTask([], { count: 0 })
    const secondStarted = vi.fn()

    const firstPromise = limit(first.run)
    const secondPromise = limit(async () => {
      secondStarted()
      return 'second'
    })

    await Promise.resolve()
    await Promise.resolve()
    expect(secondStarted).not.toHaveBeenCalled()

    first.resolve()
    await firstPromise
    await secondPromise
    expect(secondStarted).toHaveBeenCalledTimes(1)
  })

  it('should release the slot and let the next task run when a task throws', async () => {
    const limit = createConcurrencyLimiter(1)
    const failing = limit(async () => {
      throw new Error('boom')
    })
    await expect(failing).rejects.toThrow('boom')

    const next = await limit(async () => 'recovered')
    expect(next).toBe('recovered')
  })

  it('should return each task result independently, not mixed up between callers', async () => {
    const limit = createConcurrencyLimiter(1)
    const [a, b, c] = await Promise.all([
      limit(async () => 'a'),
      limit(async () => 'b'),
      limit(async () => 'c'),
    ])
    expect([a, b, c]).toEqual(['a', 'b', 'c'])
  })
})
