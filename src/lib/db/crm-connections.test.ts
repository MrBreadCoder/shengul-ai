import { describe, it, expect } from 'vitest'
import {
  getCrmConnectionForClient,
  upsertCrmConnection,
  updateCrmConnectionPipeline,
  updateCrmConnectionTokens,
  markCrmConnectionError,
  deleteCrmConnection,
} from './crm-connections'
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

function mockDelete(result: { error: unknown }) {
  return { from: () => ({ delete: () => ({ eq: () => Promise.resolve(result) }) }) } as never
}

describe('getCrmConnectionForClient', () => {
  it('should return the connection when the client has one', async () => {
    const row = { id: 'conn-1', client_id: 'c1', provider: 'hubspot' }

    const found = await getCrmConnectionForClient(mockMaybeSingle({ data: row, error: null }), 'c1')

    expect(found).toEqual(row)
  })

  it('should return null when the client has not connected a CRM', async () => {
    const found = await getCrmConnectionForClient(mockMaybeSingle({ data: null, error: null }), 'c1')

    expect(found).toBeNull()
  })

  it('should throw DB_ERROR when the query fails', async () => {
    await expect(
      getCrmConnectionForClient(mockMaybeSingle({ data: null, error: { message: 'boom' } }), 'c1'),
    ).rejects.toBeInstanceOf(AppError)
  })
})

describe('upsertCrmConnection', () => {
  const input = {
    clientId: 'c1',
    provider: 'hubspot' as const,
    accountLabel: 'Acme Portal',
    accountRef: '12345678',
    oauth: { v: 1, iv: 'i', tag: 't', data: 'd' },
  }

  it('should return the stored row when the upsert succeeds', async () => {
    const row = { id: 'conn-1', client_id: 'c1' }

    const saved = await upsertCrmConnection(mockUpsert({ data: row, error: null }), input)

    expect(saved).toEqual(row)
  })

  it('should throw DB_ERROR when the upsert fails', async () => {
    await expect(
      upsertCrmConnection(mockUpsert({ data: null, error: { message: 'boom' } }), input),
    ).rejects.toBeInstanceOf(AppError)
  })

  it('should throw DB_ERROR when the upsert returns no row', async () => {
    await expect(
      upsertCrmConnection(mockUpsert({ data: null, error: null }), input),
    ).rejects.toBeInstanceOf(AppError)
  })
})

describe('updateCrmConnectionPipeline', () => {
  const selection = {
    pipelineId: 'p1',
    pipelineLabel: 'Sales',
    initialStageId: 's1',
    wonStageId: 's9',
    lostStageId: 's10',
  }

  it('should resolve when the update succeeds', async () => {
    await expect(
      updateCrmConnectionPipeline(mockUpdate({ error: null }), 'conn-1', selection),
    ).resolves.toBeUndefined()
  })

  it('should throw DB_ERROR when the update fails', async () => {
    await expect(
      updateCrmConnectionPipeline(mockUpdate({ error: { message: 'boom' } }), 'conn-1', selection),
    ).rejects.toBeInstanceOf(AppError)
  })
})

describe('updateCrmConnectionTokens', () => {
  it('should resolve when the update succeeds', async () => {
    await expect(
      updateCrmConnectionTokens(mockUpdate({ error: null }), 'conn-1', { v: 1 }),
    ).resolves.toBeUndefined()
  })

  it('should throw DB_ERROR when the update fails', async () => {
    await expect(
      updateCrmConnectionTokens(mockUpdate({ error: { message: 'boom' } }), 'conn-1', { v: 1 }),
    ).rejects.toBeInstanceOf(AppError)
  })
})

describe('markCrmConnectionError', () => {
  it('should resolve when the update succeeds', async () => {
    await expect(
      markCrmConnectionError(mockUpdate({ error: null }), 'conn-1', 'token_revoked'),
    ).resolves.toBeUndefined()
  })

  it('should throw DB_ERROR when the update fails', async () => {
    await expect(
      markCrmConnectionError(mockUpdate({ error: { message: 'boom' } }), 'conn-1', 'token_revoked'),
    ).rejects.toBeInstanceOf(AppError)
  })
})

describe('deleteCrmConnection', () => {
  it('should resolve when the delete succeeds', async () => {
    await expect(deleteCrmConnection(mockDelete({ error: null }), 'conn-1')).resolves.toBeUndefined()
  })

  it('should throw DB_ERROR when the delete fails', async () => {
    await expect(
      deleteCrmConnection(mockDelete({ error: { message: 'boom' } }), 'conn-1'),
    ).rejects.toBeInstanceOf(AppError)
  })
})
