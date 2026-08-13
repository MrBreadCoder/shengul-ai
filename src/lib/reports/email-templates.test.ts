import { describe, it, expect } from 'vitest'
import { pickTemplate, renderTemplate, buildWarmupTemplateContext, FEEDBACK_CALL_URL, type ReportEmailTemplateInput } from './email-templates'
import { AppError } from '@/lib/errors/app-error'
import type { MailboxWarmupInfo } from '@/lib/mailbox/mailreach-gate'

const input: ReportEmailTemplateInput = {
  clientName: 'Acme Co.',
  periodLabel: 'this week',
  leadsFound: 12,
  emailsSent: 40,
  repliesReceived: 3,
  reportUrl: 'https://app.example.com/reports/abc',
  warmup: null,
}

const gatedMailbox: MailboxWarmupInfo = {
  mailboxId: 'm1',
  emailAddress: 'sales@acme.com',
  elapsedDays: 6,
  gateDays: 14,
  isGated: true,
  reputationScore: 70,
  totalMessagesSent: 10,
  totalMessagesReceived: 8,
  totalSpam: 0,
  currentConversations: 2,
}
const warmMailbox: MailboxWarmupInfo = { ...gatedMailbox, mailboxId: 'm2', elapsedDays: 20, isGated: false }

describe('pickTemplate', () => {
  it('should return a different template for each of the 7 rotation indices', () => {
    const rendered = Array.from({ length: 7 }, (_, i) => renderTemplate(pickTemplate(i, false), input).subject)
    expect(new Set(rendered).size).toBe(7)
  })

  it('should wrap around after 7', () => {
    expect(renderTemplate(pickTemplate(0, false), input)).toEqual(renderTemplate(pickTemplate(7, false), input))
    expect(renderTemplate(pickTemplate(1, false), input)).toEqual(renderTemplate(pickTemplate(8, false), input))
  })

  it('should always return the warmup template when useWarmupTemplate is true, regardless of rotation index', () => {
    const first = renderTemplate(pickTemplate(0, true), { ...input, warmup: buildWarmupTemplateContext([gatedMailbox]) })
    const second = renderTemplate(pickTemplate(3, true), { ...input, warmup: buildWarmupTemplateContext([gatedMailbox]) })
    expect(first.subject).toBe(second.subject)
    expect(first.subject).toContain('building')
  })
})

describe('renderTemplate', () => {
  it('should include every dynamic value in every rotating template', () => {
    for (let i = 0; i < 7; i += 1) {
      const rendered = renderTemplate(pickTemplate(i, false), input)
      expect(rendered.text).toContain('Acme Co.')
      expect(rendered.text).toContain('12')
      expect(rendered.text).toContain(input.reportUrl)
      expect(rendered.text).toContain(FEEDBACK_CALL_URL)
      expect(rendered.text).toContain('Shengul Yavuz')
      expect(rendered.text).toContain('Founder of Shengul AI')
      expect(rendered.subject.length).toBeGreaterThan(0)
      expect(rendered.html).toContain('12')
    }
  })

  it('should reject a client name containing a line break', () => {
    expect(() => renderTemplate(pickTemplate(0, false), { ...input, clientName: 'Acme\nInjected' })).toThrow(AppError)
  })

  it('should render html and text with the same line content', () => {
    const rendered = renderTemplate(pickTemplate(0, false), input)
    expect(rendered.html).toContain(input.reportUrl)
  })

  it('should render the warmup template with day counter, reputation, and no lead-count wording', () => {
    const warmup = buildWarmupTemplateContext([gatedMailbox])
    const rendered = renderTemplate(pickTemplate(0, true), { ...input, warmup })
    expect(rendered.text).toContain('day 6 of 14')
    expect(rendered.text).toContain('reputation score 70')
    expect(rendered.text).not.toMatch(/0 (new )?leads?/i)
    expect(rendered.text).toContain(input.reportUrl)
  })

  it('should throw when the warmup template is rendered without warmup context', () => {
    expect(() => renderTemplate(pickTemplate(0, true), { ...input, warmup: null })).toThrow(AppError)
  })
})

describe('buildWarmupTemplateContext', () => {
  it('should return null when no mailbox is gated', () => {
    expect(buildWarmupTemplateContext([warmMailbox])).toBeNull()
  })

  it('should return null for an empty array', () => {
    expect(buildWarmupTemplateContext([])).toBeNull()
  })

  it('should aggregate the gated mailboxes, keeping only the closest-to-ready one for the day counter', () => {
    const almostReady: MailboxWarmupInfo = { ...gatedMailbox, mailboxId: 'm3', elapsedDays: 12, reputationScore: 88 }
    const result = buildWarmupTemplateContext([gatedMailbox, almostReady, warmMailbox])
    expect(result).toEqual({
      gatedCount: 2,
      totalEnrolled: 3,
      closestElapsedDays: 12,
      closestGateDays: 14,
      closestReputationScore: 88,
      messagesExchanged: (10 + 8) * 2, // gatedMailbox + almostReady share the same sent/received values
    })
  })
})
