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

  it('should name the missing field in the error message when the body fails schema validation', async () => {
    // The message is the only part of this error that survives being logged
    // to the events table (everything else on `context` is dropped there), so
    // the failing field must be readable from `message` alone.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ wrong: 1 }), { status: 200 }),
    ))
    await expect(fetchJson('http://x', { method: 'GET' }, schema)).rejects.toMatchObject({
      message: expect.stringContaining('id: '),
    })
  })

  it('should name every missing field when more than one fails schema validation', async () => {
    const multiFieldSchema = z.object({ id: z.string(), email: z.string() })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ wrong: 1 }), { status: 200 }),
    ))
    const error = await fetchJson('http://x', { method: 'GET' }, multiFieldSchema).catch((e: unknown) => e)
    expect((error as Error).message).toContain('id: ')
    expect((error as Error).message).toContain('email: ')
  })

  it('should report "(root)" when the body is not an object at all', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify('just a string'), { status: 200 }),
    ))
    await expect(fetchJson('http://x', { method: 'GET' }, schema)).rejects.toMatchObject({
      message: expect.stringContaining('(root): '),
    })
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
