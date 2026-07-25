import { describe, it, expect, vi, afterEach } from 'vitest'
import { z } from 'zod'
import { fetchJson } from './fetch-json'

const schema = z.object({ id: z.string() })

afterEach(() => vi.restoreAllMocks())

describe('fetchJson', () => {
  it('should return parsed data when the response is ok and valid', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 'x' }), { status: 200 }),
    ))
    const data = await fetchJson('http://x', { method: 'GET' }, schema)
    expect(data).toEqual({ id: 'x' })
  })

  it('should throw EXTERNAL_ERROR when the status is not ok', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response('nope', { status: 500 }),
    ))
    await expect(fetchJson('http://x', { method: 'GET' }, schema)).rejects.toMatchObject({ code: 'EXTERNAL_ERROR' })
  })

  it('should throw EXTERNAL_ERROR when the body fails schema validation', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ wrong: 1 }), { status: 200 }),
    ))
    await expect(fetchJson('http://x', { method: 'GET' }, schema)).rejects.toMatchObject({ code: 'EXTERNAL_ERROR' })
  })

  it('should throw EXTERNAL_TIMEOUT when the request aborts', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url, opts: RequestInit) => {
      return new Promise((_resolve, reject) => {
        const signal = opts.signal as AbortSignal
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })
    }))
    await expect(fetchJson('http://x', { method: 'GET' }, schema, 10)).rejects.toMatchObject({ code: 'EXTERNAL_TIMEOUT' })
  })

  it('should report logUrl instead of url in error context when the status is not ok', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 402 })))
    await expect(
      fetchJson('http://x?api_key=secret', { method: 'GET' }, schema, 8000, 'http://x?api_key=REDACTED'),
    ).rejects.toMatchObject({ context: { url: 'http://x?api_key=REDACTED' } })
  })

  it('should report logUrl instead of url in error context when the request aborts', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url, opts: RequestInit) => {
      return new Promise((_resolve, reject) => {
        const signal = opts.signal as AbortSignal
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })
    }))
    await expect(
      fetchJson('http://x?api_key=secret', { method: 'GET' }, schema, 10, 'http://x?api_key=REDACTED'),
    ).rejects.toMatchObject({ context: { url: 'http://x?api_key=REDACTED' } })
  })

  it('should report logUrl instead of url in error context when the body fails validation', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ wrong: 1 }), { status: 200 }),
    ))
    await expect(
      fetchJson('http://x?api_key=secret', { method: 'GET' }, schema, 8000, 'http://x?api_key=REDACTED'),
    ).rejects.toMatchObject({ context: { url: 'http://x?api_key=REDACTED' } })
  })

  it('should fall back to url in error context when logUrl is omitted', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 500 })))
    await expect(
      fetchJson('http://plain', { method: 'GET' }, schema),
    ).rejects.toMatchObject({ context: { url: 'http://plain' } })
  })
})
