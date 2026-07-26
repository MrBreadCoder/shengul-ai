import { describe, expect, it } from 'vitest'
import { BOOKING_URL } from '@/components/landing/constants'
import { FAQ_ITEMS } from '@/components/landing/faq-items'
import { LIMITS, PRODUCT_OVERVIEW, WHAT_IT_DOES } from '@/lib/seo/product-facts'
import { buildMarketingWebMcpTools } from '@/lib/webmcp/marketing-tools'
import type { WebMcpTool } from '@/types/webmcp'

const TOOLS = buildMarketingWebMcpTools()

function toolNamed(name: string): WebMcpTool {
  const tool = TOOLS.find((candidate) => candidate.name === name)
  if (!tool) throw new Error(`No marketing tool named ${name}`)
  return tool
}

async function callTool(tool: WebMcpTool, input: unknown): Promise<string> {
  const result = await tool.execute(input)
  expect(result.isError, String(result.content[0]?.text)).toBeUndefined()
  return String(result.content[0]?.text)
}

describe('buildMarketingWebMcpTools', () => {
  it('should register exactly the three public tools', () => {
    expect(TOOLS.map(({ name }) => name)).toEqual([
      'getProductOverview',
      'answerFaq',
      'getBookingLink',
    ])
  })

  it('should mark every public tool read-only, because the page has nothing to mutate', () => {
    for (const { name, annotations } of TOOLS) {
      expect(annotations.readOnlyHint, name).toBe(true)
    }
  })

  it('should not flag any public tool as carrying untrusted content, since all of it is published copy', () => {
    for (const { name, annotations } of TOOLS) {
      expect(annotations.untrustedContentHint, name).toBe(false)
    }
  })

  it('should give every tool a title, a description, and an object input schema', () => {
    for (const tool of TOOLS) {
      expect(tool.title.length, tool.name).toBeGreaterThan(0)
      expect(tool.description.length, tool.name).toBeGreaterThan(0)
      expect(tool.inputSchema.type, tool.name).toBe('object')
    }
  })

  it('should give the two no-argument tools an empty required list', () => {
    for (const name of ['getProductOverview', 'getBookingLink']) {
      expect(toolNamed(name).inputSchema.required, name).toBeUndefined()
    }
  })
})

describe('getProductOverview', () => {
  it('should answer with the same facts /llms.txt serves, so the two cannot diverge', async () => {
    const output = JSON.parse(await callTool(toolNamed('getProductOverview'), {})) as {
      overview: string
      whatItDoes: string[]
      whatItWillNotDo: string[]
      bookingUrl: string
    }

    expect(output.overview).toBe(PRODUCT_OVERVIEW)
    expect(output.whatItDoes).toEqual(WHAT_IT_DOES)
    expect(output.whatItWillNotDo).toEqual(LIMITS)
    expect(output.bookingUrl).toBe(BOOKING_URL)
  })

  it('should run when called with no arguments at all', async () => {
    const result = await toolNamed('getProductOverview').execute(undefined)
    expect(result.isError).toBeUndefined()
    expect(result.content[0]?.text).toContain(PRODUCT_OVERVIEW)
  })
})

describe('answerFaq', () => {
  it('should require a question', async () => {
    const result = await toolNamed('answerFaq').execute({})
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('question')
  })

  it('should reject an empty question rather than dumping the whole FAQ', async () => {
    const result = await toolNamed('answerFaq').execute({ question: '   ' })
    expect(result.isError).toBe(true)
  })

  it('should reject a question long enough to be a prompt-injection payload', async () => {
    const result = await toolNamed('answerFaq').execute({ question: 'x'.repeat(501) })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('500')
  })

  it('should answer a published question with its published answer verbatim', async () => {
    const first = FAQ_ITEMS[0]
    if (!first) throw new Error('The FAQ is empty')

    const output = JSON.parse(await callTool(toolNamed('answerFaq'), { question: first.question })) as {
      matches: { question: string; answer: string }[]
    }

    expect(output.matches[0]).toEqual({ question: first.question, answer: first.answer })
  })

  it('should return no matches and say so when the FAQ does not cover the question', async () => {
    const output = JSON.parse(
      await callTool(toolNamed('answerFaq'), { question: 'Do you resell Kubernetes clusters?' }),
    ) as { matches: unknown[]; note: string }

    expect(output.matches).toEqual([])
    expect(output.note).toContain('does not cover this')
  })

  it('should return at most three matches so the transcript stays readable', async () => {
    const output = JSON.parse(
      await callTool(toolNamed('answerFaq'), { question: 'email reply approve voice send booking' }),
    ) as { matches: unknown[] }

    expect(output.matches.length).toBeLessThanOrEqual(3)
  })
})

describe('getBookingLink', () => {
  it('should return the one booking url the page converts on', async () => {
    expect(await callTool(toolNamed('getBookingLink'), {})).toContain(BOOKING_URL)
  })

  it('should say what the call is for, so an agent does not invent an agenda', async () => {
    expect(await callTool(toolNamed('getBookingLink'), {})).toMatch(/half-hour call/)
  })
})
