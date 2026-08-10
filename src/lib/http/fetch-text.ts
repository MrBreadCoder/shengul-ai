import { AppError } from '@/lib/errors/app-error'

const DEFAULT_TIMEOUT_MS = 30_000

export async function fetchText(
  url: string,
  options: RequestInit,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<string> {
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
    throw new AppError('EXTERNAL_ERROR', `HTTP ${response.status}`, {
      url, status: response.status, body: text.slice(0, 500),
    })
  }
  return response.text()
}
