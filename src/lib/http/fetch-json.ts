import type { ZodType } from 'zod'
import { AppError } from '@/lib/errors/app-error'

const DEFAULT_TIMEOUT_MS = 8000

export async function fetchJson<T>(
  url: string,
  options: RequestInit,
  schema: ZodType<T>,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let response: Response
  try {
    response = await fetch(url, { ...options, signal: controller.signal })
  } catch (cause) {
    const isAbort = cause instanceof DOMException && cause.name === 'AbortError'
    throw new AppError(isAbort ? 'EXTERNAL_TIMEOUT' : 'EXTERNAL_ERROR', 'HTTP request failed', {
      url, cause: cause instanceof Error ? cause.message : String(cause),
    })
  } finally {
    clearTimeout(timer)
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new AppError('EXTERNAL_ERROR', `HTTP ${response.status}`, { url, status: response.status, body: text.slice(0, 500) })
  }
  const json: unknown = await response.json().catch(() => undefined)
  const parsed = schema.safeParse(json)
  if (!parsed.success) {
    throw new AppError('EXTERNAL_ERROR', 'Unexpected response shape', { url, issues: parsed.error.flatten() })
  }
  return parsed.data
}
