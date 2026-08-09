import { describe, it, expect, vi } from 'vitest'
import type { ToolSet } from 'ai'
import { buildResearchTools } from './tools'
import { AppError } from '@/lib/errors/app-error'

// buildResearchTools always returns both keys with an execute function
// defined (see tools.ts) — the ToolSet index type and Tool.execute being
// optional in the SDK's types don't reflect that, so `!` is safe here.
function getExecute(tools: ToolSet, name: 'search' | 'scrape') {
  return tools[name]!.execute!
}

const logErrorMock = vi.fn()
vi.mock('@/lib/events/log-event', () => ({ logError: (...a: unknown[]) => logErrorMock(...a) }))

const context = { clientId: 'client1', caseId: 'case1', actor: 'research_agent' }

describe('buildResearchTools', () => {
  it('should return search results from the provider when search succeeds', async () => {
    const research = {
      search: vi.fn().mockResolvedValue([{ url: 'https://acme.com', title: 'Acme', content: 'widgets' }]),
      scrape: vi.fn(),
    }
    const tools = buildResearchTools({ research }, context)
    const result = await getExecute(tools, 'search')({ query: 'Acme' }, {} as never)
    expect(research.search).toHaveBeenCalledWith('Acme')
    expect(result).toEqual([{ url: 'https://acme.com', title: 'Acme', content: 'widgets' }])
  })

  it('should return an error object instead of throwing when search fails', async () => {
    const research = { search: vi.fn().mockRejectedValue(new Error('down')), scrape: vi.fn() }
    const tools = buildResearchTools({ research }, context)
    const result = await getExecute(tools, 'search')({ query: 'Acme' }, {} as never)
    expect(result).toEqual({ error: 'search failed' })
  })

  it('should return scraped text from the provider when scrape succeeds', async () => {
    const research = { search: vi.fn(), scrape: vi.fn().mockResolvedValue('# Acme page') }
    const tools = buildResearchTools({ research }, context)
    const result = await getExecute(tools, 'scrape')({ url: 'https://acme.com/about' }, {} as never)
    expect(research.scrape).toHaveBeenCalledWith('https://acme.com/about')
    expect(result).toBe('# Acme page')
  })

  it('should return an error object instead of throwing when scrape fails', async () => {
    const research = { search: vi.fn(), scrape: vi.fn().mockRejectedValue(new Error('blocked')) }
    const tools = buildResearchTools({ research }, context)
    const result = await getExecute(tools, 'scrape')({ url: 'https://acme.com' }, {} as never)
    expect(result).toEqual({ error: 'scrape failed' })
  })
})

describe('brightdata failure logging', () => {
  it('should log a brightdata.search.failed event and still return an error result to the model', async () => {
    logErrorMock.mockReset()
    const research = { search: vi.fn().mockRejectedValue(new Error('SERP 502')), scrape: vi.fn() }
    const tools = buildResearchTools({ research }, context)

    const result = await getExecute(tools, 'search')({ query: 'Acme' }, {} as never)

    expect(result).toEqual({ error: 'search failed' })
    expect(logErrorMock.mock.calls[0]?.[0]).toMatchObject({
      clientId: 'client1',
      caseId: 'case1',
      actor: 'research_agent',
      type: 'brightdata.search.failed',
      source: 'brightdata',
      payload: { query: 'Acme' },
    })
  })

  it('should log a brightdata.scrape.failed event and still return an error result to the model', async () => {
    logErrorMock.mockReset()
    const research = { search: vi.fn(), scrape: vi.fn().mockRejectedValue(new Error('403 blocked')) }
    const tools = buildResearchTools({ research }, context)

    const result = await getExecute(tools, 'scrape')({ url: 'https://acme.com' }, {} as never)

    expect(result).toEqual({ error: 'scrape failed' })
    expect(logErrorMock.mock.calls[0]?.[0]).toMatchObject({
      type: 'brightdata.scrape.failed',
      source: 'brightdata',
      payload: { url: 'https://acme.com' },
    })
  })

  it('should surface the vendor HTTP status/body from an AppError context so the reason is diagnosable', async () => {
    logErrorMock.mockReset()
    const error = new AppError('EXTERNAL_ERROR', 'HTTP 400', {
      url: 'https://api.brightdata.com/request',
      status: 400,
      body: '{"error":"zone not found"}',
    })
    const research = { search: vi.fn().mockRejectedValue(error), scrape: vi.fn() }
    const tools = buildResearchTools({ research }, context)

    await getExecute(tools, 'search')({ query: 'Acme' }, {} as never)

    expect(logErrorMock.mock.calls[0]?.[0]).toMatchObject({
      payload: { query: 'Acme', status: 400, body: '{"error":"zone not found"}', cause: null },
    })
  })

  it('should surface the underlying fetch cause when the AppError has no HTTP status (a network-level failure)', async () => {
    logErrorMock.mockReset()
    const error = new AppError('EXTERNAL_ERROR', 'HTTP request failed', {
      url: 'https://acme.com',
      cause: 'fetch failed: getaddrinfo ENOTFOUND',
    })
    const research = { search: vi.fn(), scrape: vi.fn().mockRejectedValue(error) }
    const tools = buildResearchTools({ research }, context)

    await getExecute(tools, 'scrape')({ url: 'https://acme.com' }, {} as never)

    expect(logErrorMock.mock.calls[0]?.[0]).toMatchObject({
      payload: { url: 'https://acme.com', status: null, body: null, cause: 'fetch failed: getaddrinfo ENOTFOUND' },
    })
  })

  it('should default to null details when the error is not an AppError', async () => {
    logErrorMock.mockReset()
    const research = { search: vi.fn().mockRejectedValue(new Error('plain failure')), scrape: vi.fn() }
    const tools = buildResearchTools({ research }, context)

    await getExecute(tools, 'search')({ query: 'Acme' }, {} as never)

    expect(logErrorMock.mock.calls[0]?.[0]).toMatchObject({
      payload: { query: 'Acme', status: null, body: null, cause: null },
    })
  })
})
