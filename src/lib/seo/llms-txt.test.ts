import { describe, expect, it } from 'vitest'
import { buildLlmsTxt } from '@/lib/seo/llms-txt'
import { SITE_NAME } from '@/lib/seo/site'

const INPUT = {
  siteUrl: 'https://example.com',
  bookingUrl: 'https://cal.com/example',
  faqItems: [
    { question: 'Will it sound like me?', answer: 'Yes — it writes from your own address.' },
  ],
  updatedAt: '2026-07-25T00:00:00.000Z',
} as const

describe('buildLlmsTxt', () => {
  it('should open with the site name as an H1 and a blockquote summary', () => {
    const [firstLine, blankLine, summaryLine] = buildLlmsTxt(INPUT).split('\n')
    expect(firstLine).toBe(`# ${SITE_NAME}`)
    expect(blankLine).toBe('')
    expect(String(summaryLine)).toMatch(/^> \S/)
  })

  it('should render each FAQ item as an H3 question followed by its answer', () => {
    const output = buildLlmsTxt(INPUT)
    expect(output).toContain('### Will it sound like me?')
    expect(output).toContain('Yes — it writes from your own address.')
  })

  it('should link the home and sign-in pages absolutely', () => {
    const output = buildLlmsTxt(INPUT)
    expect(output).toContain('(https://example.com/)')
    expect(output).toContain('(https://example.com/login)')
  })

  it('should surface the booking url as the contact route', () => {
    expect(buildLlmsTxt(INPUT)).toContain('https://cal.com/example')
  })

  it('should link every legal document absolutely under a legal & policy heading', () => {
    const output = buildLlmsTxt(INPUT)
    expect(output).toContain('## Legal & policy')
    expect(output).toContain('[Privacy Notice](https://example.com/legal/privacy-policy)')
    expect(output).toContain('[Terms of Service](https://example.com/legal/terms-of-service)')
    expect(output).toContain('[Cookie Notice](https://example.com/legal/cookie-policy)')
  })

  it('should end with the freshness stamp', () => {
    expect(buildLlmsTxt(INPUT).trimEnd().endsWith(`Last updated: ${INPUT.updatedAt}`)).toBe(true)
  })

  it('should still produce a valid document when there are no FAQ items', () => {
    const output = buildLlmsTxt({ ...INPUT, faqItems: [] })
    expect(output).toContain('## Frequently asked questions')
    expect(output).not.toContain('###')
  })
})
