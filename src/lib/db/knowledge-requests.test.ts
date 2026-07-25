import { describe, it, expect } from 'vitest'
import { AppError } from '@/lib/errors/app-error'
import {
  createKnowledgeRequest,
  getKnowledgeRequestById,
  listOpenKnowledgeRequestsForClient,
  claimKnowledgeRequestAnswer,
} from './knowledge-requests'

describe('createKnowledgeRequest', () => {
  it('should return the created request when the email has no existing request', async () => {
    const row = { id: 'kr1' }
    const supabase = {
      from: () => ({ upsert: () => ({ select: () => Promise.resolve({ data: [row], error: null }) }) }),
    } as never
    const result = await createKnowledgeRequest(supabase, {
      client_id: 'c1', case_id: 'case1', email_id: 'in1', question: 'What is X?',
    })
    expect(result).toEqual(row)
  })

  it('should return null when a request already exists for the email', async () => {
    const supabase = {
      from: () => ({ upsert: () => ({ select: () => Promise.resolve({ data: [], error: null }) }) }),
    } as never
    const result = await createKnowledgeRequest(supabase, {
      client_id: 'c1', case_id: 'case1', email_id: 'in1', question: 'What is X?',
    })
    expect(result).toBeNull()
  })

  it('should throw DB_ERROR when the upsert errors', async () => {
    const supabase = {
      from: () => ({ upsert: () => ({ select: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }) }),
    } as never
    await expect(
      createKnowledgeRequest(supabase, { client_id: 'c1', case_id: 'case1', email_id: 'in1', question: 'What is X?' }),
    ).rejects.toBeInstanceOf(AppError)
  })
})

describe('getKnowledgeRequestById', () => {
  it('should return the row when found', async () => {
    const row = { id: 'kr1', status: 'open' }
    const supabase = {
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: row, error: null }) }) }) }),
    } as never
    expect(await getKnowledgeRequestById(supabase, 'kr1')).toEqual(row)
  })

  it('should return null when not found', async () => {
    const supabase = {
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) }),
    } as never
    expect(await getKnowledgeRequestById(supabase, 'kr1')).toBeNull()
  })

  it('should throw DB_ERROR when the query errors', async () => {
    const supabase = {
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }) }) }),
    } as never
    await expect(getKnowledgeRequestById(supabase, 'kr1')).rejects.toBeInstanceOf(AppError)
  })
})

describe('listOpenKnowledgeRequestsForClient', () => {
  it('should return open requests', async () => {
    const rows = [{ id: 'kr1' }]
    const supabase = {
      from: () => ({ select: () => ({ eq: () => ({ order: () => Promise.resolve({ data: rows, error: null }) }) }) }),
    } as never
    expect(await listOpenKnowledgeRequestsForClient(supabase)).toEqual(rows)
  })

  it('should throw DB_ERROR when the query errors', async () => {
    const supabase = {
      from: () => ({ select: () => ({ eq: () => ({ order: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }) }) }),
    } as never
    await expect(listOpenKnowledgeRequestsForClient(supabase)).rejects.toBeInstanceOf(AppError)
  })
})

describe('claimKnowledgeRequestAnswer', () => {
  it('should return the claimed row when the request is open', async () => {
    const row = { id: 'kr1', status: 'answered' }
    const supabase = {
      from: () => ({
        update: () => ({ eq: () => ({ eq: () => ({ select: () => Promise.resolve({ data: [row], error: null }) }) }) }),
      }),
    } as never
    const result = await claimKnowledgeRequestAnswer(supabase, { id: 'kr1', answer: 'A', answeredBy: 'u1' })
    expect(result).toEqual(row)
  })

  it('should return null when the request is no longer open', async () => {
    const supabase = {
      from: () => ({
        update: () => ({ eq: () => ({ eq: () => ({ select: () => Promise.resolve({ data: [], error: null }) }) }) }),
      }),
    } as never
    const result = await claimKnowledgeRequestAnswer(supabase, { id: 'kr1', answer: 'A', answeredBy: 'u1' })
    expect(result).toBeNull()
  })

  it('should throw DB_ERROR when the update errors', async () => {
    const supabase = {
      from: () => ({
        update: () => ({ eq: () => ({ eq: () => ({ select: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }) }) }),
      }),
    } as never
    await expect(
      claimKnowledgeRequestAnswer(supabase, { id: 'kr1', answer: 'A', answeredBy: 'u1' }),
    ).rejects.toBeInstanceOf(AppError)
  })
})
