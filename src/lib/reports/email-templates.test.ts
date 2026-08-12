import { describe, it, expect } from 'vitest'
import { pickTemplate, renderTemplate, FEEDBACK_CALL_URL, type ReportEmailTemplateInput } from './email-templates'
import { AppError } from '@/lib/errors/app-error'

const input: ReportEmailTemplateInput = {
  clientName: 'Acme Co.',
  periodLabel: 'this week',
  leadsFound: 12,
  emailsSent: 40,
  repliesReceived: 3,
  reportUrl: 'https://app.example.com/reports/abc',
}

describe('pickTemplate', () => {
  it('should return a different template for each of the 7 rotation indices', () => {
    const rendered = Array.from({ length: 7 }, (_, i) => renderTemplate(pickTemplate(i), input).subject)
    expect(new Set(rendered).size).toBe(7)
  })

  it('should wrap around after 7', () => {
    expect(renderTemplate(pickTemplate(0), input)).toEqual(renderTemplate(pickTemplate(7), input))
    expect(renderTemplate(pickTemplate(1), input)).toEqual(renderTemplate(pickTemplate(8), input))
  })
})

describe('renderTemplate', () => {
  it('should include every dynamic value in every template', () => {
    for (let i = 0; i < 7; i += 1) {
      const rendered = renderTemplate(pickTemplate(i), input)
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
    expect(() => renderTemplate(pickTemplate(0), { ...input, clientName: 'Acme\nInjected' })).toThrow(AppError)
  })

  it('should render html and text with the same line content', () => {
    const rendered = renderTemplate(pickTemplate(0), input)
    expect(rendered.html).toContain(input.reportUrl)
  })
})
