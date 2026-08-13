import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('@/lib/env', () => ({ env: { EMAILABLE_API_KEY: 'super-secret-key' } }))

import { verifyEmail } from './client'

const deliverable = {
  accept_all: false,
  did_you_mean: null,
  disposable: false,
  domain: 'acme.com',
  duration: 0.493,
  email: 'jo@acme.com',
  free: false,
  mailbox_full: false,
  mx_record: 'aspmx.l.google.com',
  no_reply: false,
  reason: 'accepted_email',
  role: false,
  score: 100,
  smtp_provider: 'google',
  state: 'deliverable',
  tag: null,
  user: 'jo',
}

function stubFetch(body: string, status: number): ReturnType<typeof vi.fn> {
  const spy = vi.fn().mockResolvedValue(new Response(body, { status }))
  vi.stubGlobal('fetch', spy)
  return spy
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('verifyEmail', () => {
  it('should call the v1/verify endpoint with the email, api key and a 5 second vendor timeout', async () => {
    const spy = stubFetch(JSON.stringify(deliverable), 200)

    await verifyEmail('jo@acme.com')

    const url = new URL(String(spy.mock.calls[0]?.[0]))
    expect(url.origin + url.pathname).toBe('https://api.emailable.com/v1/verify')
    expect(url.searchParams.get('email')).toBe('jo@acme.com')
    expect(url.searchParams.get('api_key')).toBe('super-secret-key')
    expect(url.searchParams.get('timeout')).toBe('5')
  })

  it('should return the parsed result when the vendor responds with a deliverable state', async () => {
    stubFetch(JSON.stringify(deliverable), 200)

    const result = await verifyEmail('jo@acme.com')

    expect(result.state).toBe('deliverable')
    expect(result.score).toBe(100)
  })

  it('should preserve undocumented vendor fields so the audit record stays complete', async () => {
    stubFetch(JSON.stringify({ ...deliverable, brand_new_field: 'keep me' }), 200)

    const result = await verifyEmail('jo@acme.com')

    expect(result).toMatchObject({ brand_new_field: 'keep me' })
  })

  it('should still parse a response carrying only the fields we depend on', async () => {
    stubFetch(JSON.stringify({ state: 'risky', email: 'jo@acme.com' }), 200)

    const result = await verifyEmail('jo@acme.com')

    expect(result.state).toBe('risky')
  })

  it('should parse a response where score comes back null instead of omitted', async () => {
    stubFetch(JSON.stringify({ ...deliverable, score: null }), 200)

    const result = await verifyEmail('jo@acme.com')

    expect(result.state).toBe('deliverable')
    expect(result.score).toBeNull()
  })

  it.each([400, 401, 402, 403, 404, 429, 500, 503])(
    'should throw EXTERNAL_ERROR when the vendor responds %i',
    async (status) => {
      stubFetch(JSON.stringify({ message: 'nope' }), status)

      await expect(verifyEmail('jo@acme.com')).rejects.toMatchObject({
        code: 'EXTERNAL_ERROR',
        context: { status },
      })
    },
  )

  it('should throw EXTERNAL_ERROR when the vendor responds 249 without a state field', async () => {
    // 249 ("try again") is inside the Fetch spec's 200-299 "ok" range, so this
    // exercises the schema-validation failure path, not the !response.ok path
    // — there is no `status` in the thrown context here, unlike the statuses above.
    stubFetch(JSON.stringify({ message: 'nope' }), 249)

    await expect(verifyEmail('jo@acme.com')).rejects.toMatchObject({ code: 'EXTERNAL_ERROR' })
  })

  it('should throw EXTERNAL_ERROR when the response has no state field', async () => {
    stubFetch(JSON.stringify({ email: 'jo@acme.com' }), 200)

    await expect(verifyEmail('jo@acme.com')).rejects.toMatchObject({ code: 'EXTERNAL_ERROR' })
  })

  it('should throw EXTERNAL_TIMEOUT when the request aborts', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url, opts: RequestInit) => {
      return new Promise((_resolve, reject) => {
        const signal = opts.signal as AbortSignal
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })
    }))

    const assertion = expect(verifyEmail('jo@acme.com')).rejects.toMatchObject({ code: 'EXTERNAL_TIMEOUT' })
    await vi.advanceTimersByTimeAsync(10_000)
    await assertion

    vi.useRealTimers()
  })

  it('should never expose the api key in thrown error context', async () => {
    stubFetch(JSON.stringify({ message: 'insufficient credits' }), 402)

    const error = await verifyEmail('jo@acme.com').catch((e: unknown) => e)

    const serialized = JSON.stringify((error as { context: Record<string, unknown> }).context)
    expect(serialized).not.toContain('super-secret-key')
    expect(serialized).toContain('REDACTED')
  })
})
