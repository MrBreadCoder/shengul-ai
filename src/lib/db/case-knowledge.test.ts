import { describe, it, expect } from 'vitest'
import { insertKnowledge, listKnowledgeForCase, insertCompanyKnowledgeIfMissing } from './case-knowledge'
import { AppError } from '@/lib/errors/app-error'

function mockInsert(result: { data: unknown; error: unknown }) {
  return { from: () => ({ insert: () => ({ select: () => Promise.resolve(result) }) }) } as never
}
function mockList(result: { data: unknown; error: unknown }) {
  return {
    from: () => ({
      select: () => ({ eq: () => ({ order: () => Promise.resolve(result) }) }),
    }),
  } as never
}

const row = {
  client_id: 'c1', case_id: 'case1', kind: 'company' as const,
  content: 'x', source_url: null, citation: null, created_by: 'agent' as const,
}

describe('insertKnowledge', () => {
  it('should return an empty array when given no rows', async () => {
    const result = await insertKnowledge(mockInsert({ data: [], error: null }), [])
    expect(result).toEqual([])
  })

  it('should return inserted rows when the insert succeeds', async () => {
    const inserted = [{ id: 'k1' }]
    const result = await insertKnowledge(mockInsert({ data: inserted, error: null }), [row])
    expect(result).toEqual(inserted)
  })

  it('should throw DB_ERROR when the insert errors', async () => {
    await expect(
      insertKnowledge(mockInsert({ data: null, error: { message: 'boom' } }), [row]),
    ).rejects.toBeInstanceOf(AppError)
  })
})

describe('listKnowledgeForCase', () => {
  it('should return rows for the case when the query succeeds', async () => {
    const rows = [{ id: 'k1' }]
    const result = await listKnowledgeForCase(mockList({ data: rows, error: null }), 'case1')
    expect(result).toEqual(rows)
  })

  it('should throw DB_ERROR when the query errors', async () => {
    await expect(
      listKnowledgeForCase(mockList({ data: null, error: { message: 'boom' } }), 'case1'),
    ).rejects.toBeInstanceOf(AppError)
  })
})

function mockCheckThenInsert(existing: { data: unknown; error: unknown }, insert?: { data: unknown; error: unknown }) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            limit: () => Promise.resolve(existing),
          }),
        }),
      }),
      insert: () => ({
        select: () => Promise.resolve(insert),
      }),
    }),
  } as never
}

describe('insertCompanyKnowledgeIfMissing', () => {
  const input = { clientId: 'c1', caseId: 'case1', content: 'Acme Corp — Software industry.', sourceUrl: 'https://acme.com' }

  it('should skip the insert and return null when a company row already exists for the case', async () => {
    const supabase = mockCheckThenInsert({ data: [{ id: 'existing' }], error: null })

    const result = await insertCompanyKnowledgeIfMissing(supabase, input)

    expect(result).toBeNull()
  })

  it('should insert and return the new row when no company row exists for the case', async () => {
    const insertedRow = { id: 'k1', kind: 'company' }
    const supabase = mockCheckThenInsert({ data: [], error: null }, { data: [insertedRow], error: null })

    const result = await insertCompanyKnowledgeIfMissing(supabase, input)

    expect(result).toEqual(insertedRow)
  })

  it('should throw DB_ERROR when the existence check errors', async () => {
    const supabase = mockCheckThenInsert({ data: null, error: { message: 'boom' } })

    await expect(insertCompanyKnowledgeIfMissing(supabase, input)).rejects.toBeInstanceOf(AppError)
  })

  it('should throw DB_ERROR when the insert errors', async () => {
    const supabase = mockCheckThenInsert({ data: [], error: null }, { data: null, error: { message: 'boom' } })

    await expect(insertCompanyKnowledgeIfMissing(supabase, input)).rejects.toBeInstanceOf(AppError)
  })
})
