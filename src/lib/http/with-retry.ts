import { isAppError } from '@/lib/errors/app-error'

export interface RetryOptions {
  maxAttempts?: number
  baseDelayMs?: number
  maxDelayMs?: number
}

const DEFAULT_MAX_ATTEMPTS = 4
const DEFAULT_BASE_DELAY_MS = 500
const DEFAULT_MAX_DELAY_MS = 8_000

function isRetryableStatus(status: unknown): status is number {
  return typeof status === 'number' && (status === 429 || status >= 500)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Retries a fetchJson-backed call on 429/5xx responses with exponential
// backoff and jitter. fetchJson (see src/lib/http/fetch-json.ts) puts the HTTP
// status on `AppError.context.status` for every non-2xx response, so this only
// ever retries genuine rate-limit/server errors — validation failures, network
// timeouts, and 4xx client errors other than 429 are rethrown immediately.
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS

  let attempt = 0
  for (;;) {
    try {
      return await fn()
    } catch (error) {
      attempt += 1
      const status = isAppError(error) ? (error.context as { status?: unknown }).status : undefined
      if (!isRetryableStatus(status) || attempt >= maxAttempts) throw error
      const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1))
      const jitter = Math.floor(Math.random() * exponential * 0.25)
      await sleep(exponential + jitter)
    }
  }
}
