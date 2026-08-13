import { describe, expect, it } from 'vitest'
import { isPublicPath } from '@/lib/auth/public-paths'
import { LEGAL_DOCUMENTS, legalDocumentPath } from '@/lib/legal/registry'

describe('isPublicPath', () => {
  it('should allow the marketing page', () => {
    expect(isPublicPath('/')).toBe(true)
  })

  it('should allow the Turkish marketing page', () => {
    expect(isPublicPath('/tr')).toBe(true)
  })

  // Gating this behind a session would 307 the footer language switcher to
  // /login instead of switching the language — an anonymous visitor clicking
  // "Türkçe" has no session by definition.
  it('should allow the language switcher route', () => {
    expect(isPublicPath('/api/locale')).toBe(true)
  })

  it('should allow the sign-in form and the auth callback', () => {
    expect(isPublicPath('/login')).toBe(true)
    expect(isPublicPath('/auth/callback')).toBe(true)
  })

  it('should allow signed-request cron routes', () => {
    expect(isPublicPath('/api/cron/discover')).toBe(true)
  })

  it('should allow the legal index', () => {
    expect(isPublicPath('/legal')).toBe(true)
  })

  // The audience for these pages has no account by definition, so a redirect to
  // /login would make the notices unreachable by the people they address.
  it('should allow every published legal document', () => {
    for (const document of LEGAL_DOCUMENTS) {
      expect(isPublicPath(legalDocumentPath(document.slug)), document.slug).toBe(true)
    }
  })

  it('should keep the console behind the session check', () => {
    for (const path of ['/crm', '/inbox', '/campaigns', '/clients', '/settings', '/analytics']) {
      expect(isPublicPath(path), path).toBe(false)
    }
  })

  // QStash delivers these with no cookies at all. A session check here does not
  // reject the request, it 307s it to /login, and QStash follows the redirect
  // with the POST intact — so the worker sees a 405 from the sign-in page and
  // burns all of its retries. The signature check inside each route is the
  // actual authentication.
  it('should allow signed-request worker routes', () => {
    for (const path of [
      '/api/pipeline/write',
      '/api/pipeline/knowledge-scrape',
      '/api/inbound/poll',
      '/api/inbound/reply',
    ]) {
      expect(isPublicPath(path), path).toBe(true)
    }
  })

  it('should not treat a path that merely starts with a public segment as public', () => {
    expect(isPublicPath('/legalese')).toBe(false)
    expect(isPublicPath('/legal-hold')).toBe(false)
    expect(isPublicPath('/api/pipelines-admin')).toBe(false)
    expect(isPublicPath('/api/inbound-admin')).toBe(false)
    expect(isPublicPath('/track')).toBe(false)
  })
})
