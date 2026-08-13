import { describe, expect, it } from 'vitest'
import { buildLandingJsonLd, serializeJsonLd, type FaqEntry } from '@/lib/seo/json-ld'

const FAQ_ITEMS: readonly FaqEntry[] = [
  { question: 'Will it sound like me?', answer: 'Yes — it writes from your own address.' },
  { question: 'What do you need from me?', answer: 'A mailbox and a booking link.' },
]

const INPUT = {
  siteUrl: 'https://example.com',
  pagePath: '/',
  locale: 'en',
  summary: 'Managed B2B outbound, run from your own mailbox.',
  faqItems: FAQ_ITEMS,
  publishedAt: '2026-07-18T00:00:00.000Z',
  updatedAt: '2026-07-25T00:00:00.000Z',
} as const

function nodesByType(graph: Record<string, unknown>): Map<string, Record<string, unknown>> {
  const nodes = graph['@graph'] as Record<string, unknown>[]
  return new Map(nodes.map((node) => [node['@type'] as string, node]))
}

describe('buildLandingJsonLd', () => {
  it('should declare the schema.org context', () => {
    expect(buildLandingJsonLd(INPUT)['@context']).toBe('https://schema.org')
  })

  it('should emit every node type an AEO crawler checks for', () => {
    const types = [...nodesByType(buildLandingJsonLd(INPUT)).keys()]
    expect(types).toEqual(
      expect.arrayContaining(['Organization', 'WebSite', 'WebPage', 'FAQPage', 'ImageObject']),
    )
  })

  it('should carry both freshness dates on the WebPage node', () => {
    const webPage = nodesByType(buildLandingJsonLd(INPUT)).get('WebPage')
    expect(webPage?.datePublished).toBe(INPUT.publishedAt)
    expect(webPage?.dateModified).toBe(INPUT.updatedAt)
  })

  it('should turn every FAQ item into a Question with an accepted answer', () => {
    const faqPage = nodesByType(buildLandingJsonLd(INPUT)).get('FAQPage')
    expect(faqPage?.mainEntity).toEqual([
      {
        '@type': 'Question',
        name: 'Will it sound like me?',
        acceptedAnswer: { '@type': 'Answer', text: 'Yes — it writes from your own address.' },
      },
      {
        '@type': 'Question',
        name: 'What do you need from me?',
        acceptedAnswer: { '@type': 'Answer', text: 'A mailbox and a booking link.' },
      },
    ])
  })

  it('should produce an empty mainEntity when there are no FAQ items', () => {
    const faqPage = nodesByType(buildLandingJsonLd({ ...INPUT, faqItems: [] })).get('FAQPage')
    expect(faqPage?.mainEntity).toEqual([])
  })

  it('should cross-reference nodes by resolvable @id', () => {
    const nodes = nodesByType(buildLandingJsonLd(INPUT))
    const ids = new Set([...nodes.values()].map((node) => node['@id']))
    const webPage = nodes.get('WebPage')
    expect(ids.has((webPage?.isPartOf as { '@id': string })['@id'])).toBe(true)
    expect(ids.has((webPage?.about as { '@id': string })['@id'])).toBe(true)
  })

  it('should build absolute URLs even when the origin has a trailing slash', () => {
    const webPage = nodesByType(buildLandingJsonLd({ ...INPUT, siteUrl: 'https://example.com' })).get(
      'WebPage',
    )
    expect(webPage?.url).toBe('https://example.com/')
  })

  it('should anchor the WebPage/FAQPage ids to the given pagePath, not always /', () => {
    const built = buildLandingJsonLd({ ...INPUT, pagePath: '/tr' })
    const webPage = nodesByType(built).get('WebPage')
    const faqPage = nodesByType(built).get('FAQPage')
    expect(webPage?.url).toBe('https://example.com/tr')
    expect(webPage?.['@id']).toBe('https://example.com/tr#webpage')
    expect(faqPage?.['@id']).toBe('https://example.com/tr#faq')
  })

  it('should keep Organization/WebSite anchored to the site root regardless of pagePath', () => {
    const built = buildLandingJsonLd({ ...INPUT, pagePath: '/tr' })
    const nodes = nodesByType(built)
    expect(nodes.get('Organization')?.['@id']).toBe('https://example.com/#organization')
    expect(nodes.get('WebSite')?.['@id']).toBe('https://example.com/#website')
  })

  it('should reflect the given locale and summary on every node', () => {
    const built = buildLandingJsonLd({ ...INPUT, locale: 'tr', summary: 'Türkçe özet.' })
    const nodes = nodesByType(built)
    expect(nodes.get('WebPage')?.inLanguage).toBe('tr')
    expect(nodes.get('FAQPage')?.inLanguage).toBe('tr')
    expect(nodes.get('Organization')?.description).toBe('Türkçe özet.')
  })
})

describe('serializeJsonLd', () => {
  it('should escape a script-closing sequence hidden in content', () => {
    const output = serializeJsonLd({ name: '</script><img onerror=alert(1)>' })
    expect(output).not.toContain('</script>')
    expect(output).not.toContain('<')
    expect(output).not.toContain('>')
  })

  it('should escape ampersands', () => {
    expect(serializeJsonLd({ name: 'a&b' })).toBe('{"name":"a\\u0026b"}')
  })

  it('should round-trip back to the original value', () => {
    const value = { name: 'Shengul AI', tags: ['a<b', 'c&d'] }
    expect(JSON.parse(serializeJsonLd(value))).toEqual(value)
  })
})
