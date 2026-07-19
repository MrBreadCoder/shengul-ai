import { describe, it, expect, vi, beforeEach } from 'vitest'

const verifyMock = vi.fn()
let verifyShouldThrow: Error | null = null

vi.mock('@upstash/qstash', () => ({
  Receiver: class {
    // Method, not a class field: field initializers run at `new Receiver()`
    // time, which (via vi.mock hoisting) happens before `verifyMock` above is
    // initialized. A method body only reads the closure at call time.
    //
    // The throw path is a plain rejection (not routed through verifyMock/
    // mockImplementation) because vi.fn()'s own internal call-result
    // tracking attaches a bare `.then()` to the returned promise with no
    // rejection handler, which flags an "unhandled rejection" for that
    // derived promise even though verify.ts's own try/catch correctly
    // catches the original promise. Confirmed by manual instrumentation:
    // the catch always received the right AppError; only vi.fn()'s
    // rejection-tracking `.then()` was the unhandled one.
    async verify(...args: unknown[]) {
      if (verifyShouldThrow) throw verifyShouldThrow
      return verifyMock(...args)
    }
  },
}))

import { verifyQstashSignature } from './verify'
import { AppError } from '@/lib/errors/app-error'

function req(body: string, signature: string | null): Request {
  const headers = new Headers()
  if (signature !== null) headers.set('upstash-signature', signature)
  return new Request('http://localhost/api/cron/hello', { method: 'POST', body, headers })
}

describe('verifyQstashSignature', () => {
  beforeEach(() => {
    verifyMock.mockReset()
    verifyShouldThrow = null
  })

  it('should return the raw body when the signature is valid', async () => {
    verifyMock.mockResolvedValue(true)
    const body = await verifyQstashSignature(req('{"hi":true}', 'sig'))
    expect(body).toBe('{"hi":true}')
  })

  it('should throw UNAUTHORIZED when the signature header is missing', async () => {
    await expect(verifyQstashSignature(req('{}', null))).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  })

  it('should throw UNAUTHORIZED when verification returns false', async () => {
    verifyMock.mockResolvedValue(false)
    await expect(verifyQstashSignature(req('{}', 'bad'))).rejects.toBeInstanceOf(AppError)
  })

  it('should throw UNAUTHORIZED when the receiver throws', async () => {
    verifyShouldThrow = new Error('sig mismatch')
    await expect(verifyQstashSignature(req('{}', 'bad'))).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  })
})
