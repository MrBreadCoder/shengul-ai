import { describe, it, expect } from 'vitest'
import { listCasesWithLeads, listCaseCompanyNames } from './crm'
import { AppError } from '@/lib/errors/app-error'

function mockSupabase(result: { data: unknown; error: unknown }) {
  return {
    from: () => ({ select: () => ({ order: () => Promise.resolve(result) }) }),
  } as never
}

function mockSelect(result: { data: unknown; error: unknown }) {
  return { from: () => ({ select: () => Promise.resolve(result) }) } as never
}

describe('listCasesWithLeads', () => {
  it('should return cases with their embedded leads', async () => {
    const rows = [{ id: 'case1', status: 'new', leads: [{ id: 'lead1', full_name: 'Jo Doe' }] }]
    const result = await listCasesWithLeads(mockSupabase({ data: rows, error: null }))
    expect(result).toEqual(rows)
  })

  it('should return an empty array when there are no cases', async () => {
    const result = await listCasesWithLeads(mockSupabase({ data: null, error: null }))
    expect(result).toEqual([])
  })

  it('should throw DB_ERROR when the query errors', async () => {
    await expect(listCasesWithLeads(mockSupabase({ data: null, error: { message: 'boom' } }))).rejects.toBeInstanceOf(AppError)
  })
})

describe('listCaseCompanyNames', () => {
  it('should map snake_case rows to a camelCase id/companyName shape', async () => {
    const rows = [{ id: 'case1', company_name: 'Acme' }, { id: 'case2', company_name: 'Globex' }]
    const result = await listCaseCompanyNames(mockSelect({ data: rows, error: null }))
    expect(result).toEqual([
      { id: 'case1', companyName: 'Acme' },
      { id: 'case2', companyName: 'Globex' },
    ])
  })

  it('should return an empty array when there are no cases', async () => {
    expect(await listCaseCompanyNames(mockSelect({ data: null, error: null }))).toEqual([])
  })

  it('should throw DB_ERROR when the query errors', async () => {
    await expect(
      listCaseCompanyNames(mockSelect({ data: null, error: { message: 'boom' } })),
    ).rejects.toBeInstanceOf(AppError)
  })
})
