import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { AppError } from '@/lib/errors/app-error'
import { fetchText } from './fetch-text'

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

describe('fetchText', () => {
  it('should return the response body as text when the request succeeds', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => '# Acme\nWe build widgets' })
    const body = await fetchText('https://acme.com', { method: 'GET' })
    expect(body).toBe('# Acme\nWe build widgets')
  })

  it('should throw EXTERNAL_ERROR when the response is not ok', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503, text: async () => 'unavailable' })
    await expect(fetchText('https://acme.com', { method: 'GET' })).rejects.toMatchObject({ code: 'EXTERNAL_ERROR' })
  })

  it('should throw EXTERNAL_TIMEOUT when the fetch aborts', async () => {
    fetchMock.mockRejectedValue(new DOMException('aborted', 'AbortError'))
    await expect(fetchText('https://acme.com', { method: 'GET' })).rejects.toMatchObject({ code: 'EXTERNAL_TIMEOUT' })
  })

  it('should throw EXTERNAL_ERROR when the transport fails for a non-abort reason', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNRESET'))
    const error = await fetchText('https://acme.com', { method: 'GET' }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AppError)
    expect((error as AppError).code).toBe('EXTERNAL_ERROR')
  })
})
