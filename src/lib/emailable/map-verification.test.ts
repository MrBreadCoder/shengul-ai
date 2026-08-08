import { describe, it, expect } from 'vitest'
import { mapEmailableVerdict } from './map-verification'
import type { EmailableResult } from './types'

const CHECKED_AT = '2026-07-21T10:00:00.000Z'

function result(state: string, reason: string): EmailableResult {
  return { state, reason, email: 'jo@acme.com', score: 100 }
}

function ok(state: string, reason: string) {
  return mapEmailableVerdict({ ok: true, result: result(state, reason) }, CHECKED_AT)
}

function okWithAcceptAll(state: string, reason: string, acceptAll: boolean | null | undefined) {
  return mapEmailableVerdict(
    { ok: true, result: { ...result(state, reason), accept_all: acceptAll } },
    CHECKED_AT,
  )
}

describe('mapEmailableVerdict', () => {
  it('should activate the lead when the state is deliverable', () => {
    const verdict = ok('deliverable', 'accepted_email')

    expect(verdict.emailStatus).toBe('verified')
    expect(verdict.leadStatus).toBe('active')
  })

  it.each(['invalid_email', 'invalid_domain', 'rejected_email', 'invalid_smtp'])(
    'should park the lead as invalid when undeliverable for reason %s',
    (reason) => {
      const verdict = ok('undeliverable', reason)

      expect(verdict.emailStatus).toBe('invalid')
      expect(verdict.leadStatus).toBe('parked')
    },
  )

  it.each(['low_quality', 'low_deliverability'])(
    'should park the lead as risky when risky for reason %s',
    (reason) => {
      const verdict = ok('risky', reason)

      expect(verdict.emailStatus).toBe('risky')
      expect(verdict.leadStatus).toBe('parked')
    },
  )

  it('should activate a risky/low_deliverability lead when the domain is accept_all', () => {
    const verdict = okWithAcceptAll('risky', 'low_deliverability', true)

    expect(verdict.emailStatus).toBe('risky')
    expect(verdict.leadStatus).toBe('active')
  })

  it.each([false, null, undefined])(
    'should still park a risky/low_deliverability lead when accept_all is %s',
    (acceptAll) => {
      const verdict = okWithAcceptAll('risky', 'low_deliverability', acceptAll)

      expect(verdict.leadStatus).toBe('parked')
    },
  )

  it('should still park a risky/low_quality lead even when the domain is accept_all', () => {
    const verdict = okWithAcceptAll('risky', 'low_quality', true)

    expect(verdict.emailStatus).toBe('risky')
    expect(verdict.leadStatus).toBe('parked')
  })

  it('should be case and whitespace insensitive about the reason in the catch-all carve-out', () => {
    const verdict = okWithAcceptAll('risky', ' Low_Deliverability ', true)

    expect(verdict.leadStatus).toBe('active')
  })

  it('should preserve accept_all in the audit record for an activated catch-all lead', () => {
    const verdict = okWithAcceptAll('risky', 'low_deliverability', true)

    expect(verdict.verification).toMatchObject({
      provider: 'emailable',
      outcome: 'checked',
      state: 'risky',
      reason: 'low_deliverability',
      accept_all: true,
    })
  })

  it.each(['no_connect', 'timeout', 'unavailable_smtp', 'unexpected_error'])(
    'should park the lead as unverified when unknown for reason %s',
    (reason) => {
      const verdict = ok('unknown', reason)

      expect(verdict.emailStatus).toBe('unverified')
      expect(verdict.leadStatus).toBe('parked')
    },
  )

  it('should park the lead when the vendor returns a state we do not recognise', () => {
    const verdict = ok('brand_new_state', 'whatever')

    expect(verdict.emailStatus).toBe('unverified')
    expect(verdict.leadStatus).toBe('parked')
  })

  it('should park the lead on the batch-only duplicate state, which /v1/verify should never return', () => {
    const verdict = ok('duplicate', 'whatever')

    expect(verdict.leadStatus).toBe('parked')
  })

  it('should be case and whitespace insensitive about the state', () => {
    expect(ok(' Deliverable ', 'accepted_email').leadStatus).toBe('active')
    expect(ok('UNDELIVERABLE', 'rejected_email').emailStatus).toBe('invalid')
  })

  it('should record the full vendor response for audit when a verdict was returned', () => {
    const verdict = ok('risky', 'low_quality')

    expect(verdict.verification).toMatchObject({
      provider: 'emailable',
      outcome: 'checked',
      checkedAt: CHECKED_AT,
      state: 'risky',
      reason: 'low_quality',
      score: 100,
    })
  })

  it('should preserve undocumented vendor fields in the audit record', () => {
    const verdict = mapEmailableVerdict(
      { ok: true, result: { ...result('deliverable', 'accepted_email'), brand_new_field: 'keep me' } },
      CHECKED_AT,
    )

    expect(verdict.verification).toMatchObject({ brand_new_field: 'keep me' })
  })

  it('should fail open and activate the lead on Apollo\'s word when the call failed', () => {
    const verdict = mapEmailableVerdict({ ok: false, error: 'HTTP 402' }, CHECKED_AT)

    expect(verdict.emailStatus).toBe('verified')
    expect(verdict.leadStatus).toBe('active')
  })

  it('should record the failure so a fail-open lead is distinguishable from a verified one', () => {
    const verdict = mapEmailableVerdict({ ok: false, error: 'HTTP 402' }, CHECKED_AT)

    expect(verdict.verification).toEqual({
      provider: 'emailable',
      outcome: 'failed',
      error: 'HTTP 402',
      checkedAt: CHECKED_AT,
    })
  })
})
