import { describe, it, expect } from 'vitest'
import { isSuppressed, addSuppression, getSuppression } from './suppressions'
import { AppError } from '@/lib/errors/app-error'

function mockInsert(result: { error: unknown }) {
  return { from: () => ({ upsert: () => Promise.resolve(result) }) } as never
}

function mockSuppressionLookup(result: { data: unknown; error: unknown }) {
  return {
    from: () => ({
      select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve(result) }) }) }),
    }),
  } as never
}

describe('getSuppression', () => {
  it('should return the matching suppression with its reason', async () => {
    const match = await getSuppression(
      mockSuppressionLookup({ data: { email: 'a@b.com', reason: 'bounced' }, error: null }),
      'c1',
      'a@b.com',
    )
    expect(match).toEqual({ email: 'a@b.com', reason: 'bounced' })
  })

  it('should return null when the address is not suppressed', async () => {
    const match = await getSuppression(mockSuppressionLookup({ data: null, error: null }), 'c1', 'a@b.com')
    expect(match).toBeNull()
  })

  it('should throw DB_ERROR when the query fails', async () => {
    await expect(
      getSuppression(mockSuppressionLookup({ data: null, error: { message: 'boom' } }), 'c1', 'a@b.com'),
    ).rejects.toBeInstanceOf(AppError)
  })
})

describe('isSuppressed', () => {
  it('should be true when a suppression exists', async () => {
    const suppressed = await isSuppressed(
      mockSuppressionLookup({ data: { email: 'a@b.com', reason: 'replied' }, error: null }),
      'c1',
      'a@b.com',
    )
    expect(suppressed).toBe(true)
  })

  it('should be false when no suppression exists', async () => {
    const suppressed = await isSuppressed(mockSuppressionLookup({ data: null, error: null }), 'c1', 'a@b.com')
    expect(suppressed).toBe(false)
  })
})

describe('addSuppression', () => {
  it('should resolve when the upsert succeeds', async () => {
    await expect(
      addSuppression(mockInsert({ error: null }), { clientId: 'c1', email: 'a@b.com', reason: 'replied' }),
    ).resolves.toBeUndefined()
  })

  it('should throw DB_ERROR when the upsert errors', async () => {
    await expect(
      addSuppression(mockInsert({ error: { message: 'boom' } }), { clientId: 'c1', email: 'a@b.com', reason: 'replied' }),
    ).rejects.toBeInstanceOf(AppError)
  })
})
