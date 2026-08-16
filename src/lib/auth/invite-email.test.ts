import { describe, it, expect } from 'vitest'
import { renderInviteEmail } from './invite-email'

const BASE_INPUT = {
  clientName: 'Acme',
  link: 'https://app.example.com/auth/callback?token=abc123&next=/set-password',
  expiresInMinutes: 4320,
}

describe('renderInviteEmail', () => {
  it('should include the client name and link in the body', () => {
    const rendered = renderInviteEmail(BASE_INPUT)
    expect(rendered.subject).toContain('Acme')
    expect(rendered.text).toContain('Acme')
    expect(rendered.text).toContain(BASE_INPUT.link)
  })

  it('should describe the expiry window in the body', () => {
    const rendered = renderInviteEmail(BASE_INPUT)
    expect(rendered.text).toContain('3 days')
  })

  it('should render html that escapes markup and preserves the link', () => {
    const rendered = renderInviteEmail(BASE_INPUT)
    // `&` is HTML-escaped like any other body text, so the assertion checks
    // for the escaped form rather than the raw link.
    expect(rendered.html).toContain(BASE_INPUT.link.replace(/&/g, '&amp;'))
    expect(rendered.html).toContain('white-space: pre-line')
  })

  it('should escape angle brackets and ampersands in the html body', () => {
    const rendered = renderInviteEmail({ ...BASE_INPUT, clientName: 'A & B <ok>' })
    expect(rendered.html).toContain('A &amp; B &lt;ok&gt;')
    expect(rendered.html).not.toContain('<ok>')
  })

  it('should throw when the client name contains a header-injection line break', () => {
    expect(() => renderInviteEmail({ ...BASE_INPUT, clientName: 'Acme\nBcc: attacker@evil.com' })).toThrow()
  })

  it('should throw when the link contains a header-injection line break', () => {
    expect(() => renderInviteEmail({ ...BASE_INPUT, link: 'https://x.test\nBcc: attacker@evil.com' })).toThrow()
  })
})
