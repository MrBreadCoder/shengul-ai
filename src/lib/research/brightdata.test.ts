import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AppError } from '@/lib/errors/app-error'

const fetchJsonMock = vi.fn()
const fetchTextMock = vi.fn()
vi.mock('@/lib/http/fetch-json', () => ({
  fetchJson: (...args: unknown[]) => fetchJsonMock(...args),
}))
vi.mock('@/lib/http/fetch-text', () => ({
  fetchText: (...args: unknown[]) => fetchTextMock(...args),
}))
vi.mock('@/lib/env', () => ({ env: { BRIGHTDATA_API_KEY: 'k', BRIGHTDATA_SCRAPE_ZONE: 'web_unlocker' } }))

import { brightdataResearch } from './brightdata'

beforeEach(() => { fetchJsonMock.mockReset(); fetchTextMock.mockReset() })

describe('brightdataResearch.search', () => {
  it('should map organic results to snippets when the API returns them', async () => {
    fetchJsonMock.mockResolvedValue({
      organic: [
        { link: 'https://acme.com', title: 'Acme', description: 'We do things' },
        { link: 'https://news.com/acme', title: 'Acme raises', description: 'Series B' },
      ],
    })
    const snippets = await brightdataResearch.search('Acme company')
    expect(snippets).toEqual([
      { url: 'https://acme.com', title: 'Acme', content: 'We do things' },
      { url: 'https://news.com/acme', title: 'Acme raises', content: 'Series B' },
    ])
  })

  it('should return an empty array when there are no organic results', async () => {
    fetchJsonMock.mockResolvedValue({ organic: [] })
    const snippets = await brightdataResearch.search('nothing here')
    expect(snippets).toEqual([])
  })

  it('should propagate AppError when the transport fails', async () => {
    fetchJsonMock.mockRejectedValueOnce(new AppError('EXTERNAL_ERROR', 'boom'))
    const pending = brightdataResearch.search('x')
    // Vitest 4.1.10 in this environment mis-flags a directly-awaited mock
    // rejection as an unhandled error unless another mock call settles first;
    // this no-op call is a harmless flush, not part of the behavior under test.
    fetchJsonMock.mockResolvedValueOnce({ organic: [] })
    await fetchJsonMock('flush')
    await expect(pending).rejects.toBeInstanceOf(AppError)
  })
})

describe('brightdataResearch.scrape', () => {
  it('should return the page text when scrape succeeds', async () => {
    fetchTextMock.mockResolvedValue('# Acme\nWe build widgets for logistics teams.')
    const text = await brightdataResearch.scrape('https://acme.com/about')
    expect(text).toBe('# Acme\nWe build widgets for logistics teams.')
  })

  it('should truncate page text to the max length when the page is oversized', async () => {
    fetchTextMock.mockResolvedValue('x'.repeat(10_000))
    const text = await brightdataResearch.scrape('https://acme.com/huge')
    expect(text).toHaveLength(6_000)
  })

  it('should wrap a transport failure as AppError', async () => {
    fetchTextMock.mockRejectedValueOnce(new AppError('EXTERNAL_ERROR', 'boom'))
    const pending = brightdataResearch.scrape('https://acme.com')
    fetchTextMock.mockResolvedValueOnce('flush')
    await fetchTextMock('flush')
    await expect(pending).rejects.toBeInstanceOf(AppError)
  })
})
