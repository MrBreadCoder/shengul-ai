import { describe, it, expect } from 'vitest'
import { isSuppressed, addSuppression, getSuppression, getSuppressions } from './suppressions'
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

function mockBulkSuppressionLookup(result: { data: unknown; error: unknown }) {
  return {
    from: () => ({
      select: () => ({ eq: () => ({ in: () => Promise.resolve(result) }) }),
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

describe('getSuppressions', () => {
  it('should return the set of emails that are suppressed for this client', async () => {
    const result = await getSuppressions(
      mockBulkSuppressionLookup({ data: [{ email: 'a@b.com' }, { email: 'c@d.com' }], error: null }),
      'c1',
      ['a@b.com', 'c@d.com', 'e@f.com'],
    )
    expect(result).toEqual(new Set(['a@b.com', 'c@d.com']))
  })

  it('should return an empty set when none of the emails are suppressed', async () => {
    const result = await getSuppressions(mockBulkSuppressionLookup({ data: [], error: null }), 'c1', ['a@b.com'])
    expect(result).toEqual(new Set())
  })

  it('should normalize emails to lowercase and trimmed before querying', async () => {
    let queriedEmails: string[] = []
    const supabase = {
      from: () => ({
        select: () => ({
          eq: () => ({
            in: (_column: string, values: string[]) => {
              queriedEmails = values
              return Promise.resolve({ data: [], error: null })
            },
          }),
        }),
      }),
    } as never
    await getSuppressions(supabase, 'c1', ['  A@B.com  ', 'C@D.COM'])
    expect(queriedEmails).toEqual(['a@b.com', 'c@d.com'])
  })

  it('should throw DB_ERROR when the query fails', async () => {
    await expect(
      getSuppressions(mockBulkSuppressionLookup({ data: null, error: { message: 'boom' } }), 'c1', ['a@b.com']),
    ).rejects.toBeInstanceOf(AppError)
  })
})
