import { describe, expect, it } from 'vitest'
import { isPublicPath } from '@/lib/auth/public-paths'
import { LEGAL_DOCUMENTS, legalDocumentPath } from '@/lib/legal/registry'

describe('isPublicPath', () => {
  it('should allow the marketing page', () => {
    expect(isPublicPath('/')).toBe(true)
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

  it('should keep pipeline routes behind the session check', () => {
    expect(isPublicPath('/api/pipeline/write')).toBe(false)
  })

  it('should not treat a path that merely starts with a public segment as public', () => {
    expect(isPublicPath('/legalese')).toBe(false)
    expect(isPublicPath('/legal-hold')).toBe(false)
  })
})
