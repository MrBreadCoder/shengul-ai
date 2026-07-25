import { ZodType } from 'zod'
import { AppError } from '@/lib/errors/app-error'

const DEFAULT_TIMEOUT_MS = 8000

/**
 * @param logUrl - URL recorded in `AppError.context` instead of `url`. Callers
 * that authenticate by query parameter pass a redacted copy: error context is
 * written to the `events` table and rendered on the operator-facing Logs tab,
 * so a secret in the real URL would leak there. Defaults to `url`.
 */
export async function fetchJson<T>(
  url: string,
  options: RequestInit,
  schema: ZodType<T>,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  logUrl: string = url,
): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let response: Response
  try {
    response = await fetch(url, { ...options, signal: controller.signal })
  } catch (cause) {
    const isAbort = cause instanceof DOMException && cause.name === 'AbortError'
    throw new AppError(isAbort ? 'EXTERNAL_TIMEOUT' : 'EXTERNAL_ERROR', 'HTTP request failed', {
      url: logUrl, cause: cause instanceof Error ? cause.message : String(cause),
    })
  } finally {
    clearTimeout(timer)
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new AppError('EXTERNAL_ERROR', `HTTP ${response.status}`, { url: logUrl, status: response.status, body: text.slice(0, 500) })
  }
  const json: unknown = await response.json().catch(() => undefined)
  const parsed = schema.safeParse(json)
  if (!parsed.success) {
    throw new AppError('EXTERNAL_ERROR', 'Unexpected response shape', { url: logUrl, issues: parsed.error.flatten() })
  }
  return parsed.data
}
