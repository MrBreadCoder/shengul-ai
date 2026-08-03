import { describe, it, expect, vi } from 'vitest'
import {
  getCaseCrmLink,
  ensureCaseCrmLink,
  claimCrmSync,
  updateCaseCrmLinkIds,
  markCrmSyncResult,
  getLatestCrmSyncAt,
} from './case-crm-links'
import { AppError } from '@/lib/errors/app-error'

function mockMaybeSingle(result: { data: unknown; error: unknown }) {
  return {
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve(result) }) }) }),
  } as never
}

function mockUpsert(result: { data: unknown; error: unknown }) {
  return {
    from: () => ({ upsert: () => ({ select: () => ({ single: () => Promise.resolve(result) }) }) }),
  } as never
}

function mockUpdate(result: { error: unknown }) {
  return { from: () => ({ update: () => ({ eq: () => Promise.resolve(result) }) }) } as never
}

/**
 * claimCrmSync chains .update().eq().or().select(). `capture` records the `or`
 * filter string so the test can assert the staleness predicate is present.
 */
function mockClaim(result: { data: unknown; error: unknown }, capture?: (filter: string) => void) {
  return {
    from: () => ({
      update: () => ({
        eq: () => ({
          or: (filter: string) => {
            capture?.(filter)
            return { select: () => Promise.resolve(result) }
          },
        }),
      }),
    }),
  } as never
}

describe('getCaseCrmLink', () => {
  it('should return the link when the case has been synced before', async () => {
    const row = { id: 'link-1', case_id: 'case-1', external_deal_id: 'deal-9' }

    expect(await getCaseCrmLink(mockMaybeSingle({ data: row, error: null }), 'case-1')).toEqual(row)
  })

  it('should return null when the case has never been synced', async () => {
    expect(await getCaseCrmLink(mockMaybeSingle({ data: null, error: null }), 'case-1')).toBeNull()
  })

  it('should throw DB_ERROR when the query fails', async () => {
    await expect(
      getCaseCrmLink(mockMaybeSingle({ data: null, error: { message: 'boom' } }), 'case-1'),
    ).rejects.toBeInstanceOf(AppError)
  })
})

describe('ensureCaseCrmLink', () => {
  const input = { clientId: 'c1', caseId: 'case-1', crmConnectionId: 'conn-1' }

  it('should return the row when the upsert succeeds', async () => {
    const row = { id: 'link-1', case_id: 'case-1' }

    expect(await ensureCaseCrmLink(mockUpsert({ data: row, error: null }), input)).toEqual(row)
  })

  it('should throw DB_ERROR when the upsert fails', async () => {
    await expect(
      ensureCaseCrmLink(mockUpsert({ data: null, error: { message: 'boom' } }), input),
    ).rejects.toBeInstanceOf(AppError)
  })

  it('should throw DB_ERROR when the upsert returns no row', async () => {
    await expect(
      ensureCaseCrmLink(mockUpsert({ data: null, error: null }), input),
    ).rejects.toBeInstanceOf(AppError)
  })
})

describe('claimCrmSync', () => {
  const now = new Date('2026-08-02T12:00:00.000Z')

  it('should return true when the claim updated a row', async () => {
    expect(await claimCrmSync(mockClaim({ data: [{ id: 'link-1' }], error: null }), 'case-1', now)).toBe(true)
  })

  it('should return false when another worker already holds a fresh claim', async () => {
    expect(await claimCrmSync(mockClaim({ data: [], error: null }), 'case-1', now)).toBe(false)
  })

  it('should allow reclaiming a claim older than the staleness cutoff', async () => {
    const capture = vi.fn()

    await claimCrmSync(mockClaim({ data: [{ id: 'link-1' }], error: null }, capture), 'case-1', now)

    // 5 minutes before `now`, so a crashed worker cannot deadlock the case.
    expect(capture).toHaveBeenCalledWith(
      'sync_started_at.is.null,sync_started_at.lt.2026-08-02T11:55:00.000Z',
    )
  })

  it('should throw DB_ERROR when the claim query fails', async () => {
    await expect(
      claimCrmSync(mockClaim({ data: null, error: { message: 'boom' } }), 'case-1', now),
    ).rejects.toBeInstanceOf(AppError)
  })
})

describe('updateCaseCrmLinkIds', () => {
  it('should resolve when the update succeeds', async () => {
    await expect(
      updateCaseCrmLinkIds(mockUpdate({ error: null }), 'case-1', { externalCompanyId: 'co-1' }),
    ).resolves.toBeUndefined()
  })

  it('should throw DB_ERROR when the update fails', async () => {
    await expect(
      updateCaseCrmLinkIds(mockUpdate({ error: { message: 'boom' } }), 'case-1', { externalCompanyId: 'co-1' }),
    ).rejects.toBeInstanceOf(AppError)
  })
})

describe('markCrmSyncResult', () => {
  it('should resolve when recording a successful sync', async () => {
    await expect(
      markCrmSyncResult(mockUpdate({ error: null }), 'case-1', { status: 'ok' }),
    ).resolves.toBeUndefined()
  })

  it('should resolve when recording a failed sync with its message', async () => {
    await expect(
      markCrmSyncResult(mockUpdate({ error: null }), 'case-1', { status: 'error', message: 'bad field' }),
    ).resolves.toBeUndefined()
  })

  it('should throw DB_ERROR when the update fails', async () => {
    await expect(
      markCrmSyncResult(mockUpdate({ error: { message: 'boom' } }), 'case-1', { status: 'ok' }),
    ).rejects.toBeInstanceOf(AppError)
  })
})

describe('getLatestCrmSyncAt', () => {
  function mockLatest(result: { data: unknown; error: unknown }) {
    return {
      from: () => ({
        select: () => ({
          eq: () => ({
            not: () => ({
              order: () => ({ limit: () => ({ maybeSingle: () => Promise.resolve(result) }) }),
            }),
          }),
        }),
      }),
    } as never
  }

  it('should return the timestamp when the connection has synced at least once', async () => {
    const at = '2026-08-02T10:00:00.000Z'

    expect(await getLatestCrmSyncAt(mockLatest({ data: { last_synced_at: at }, error: null }), 'conn-1')).toBe(at)
  })

  it('should return null when nothing has synced yet', async () => {
    expect(await getLatestCrmSyncAt(mockLatest({ data: null, error: null }), 'conn-1')).toBeNull()
  })

  it('should throw DB_ERROR when the query fails', async () => {
    await expect(
      getLatestCrmSyncAt(mockLatest({ data: null, error: { message: 'boom' } }), 'conn-1'),
    ).rejects.toBeInstanceOf(AppError)
  })
})
