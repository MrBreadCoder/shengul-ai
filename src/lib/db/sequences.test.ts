import { describe, it, expect, vi } from 'vitest'
import {
  createSequence,
  getSequenceById,
  advanceSequence,
  stopSequence,
  pauseActiveSequenceForLead,
  stopSequenceForLead,
  isSequenceActiveForLead,
  requestFollowupSkip,
  consumeFollowupSkip,
} from './sequences'
import { AppError } from '@/lib/errors/app-error'

function mockUpsert(result: { data: unknown; error: unknown }) {
  return { from: () => ({ upsert: () => ({ select: () => Promise.resolve(result) }) }) } as never
}
function mockGet(result: { data: unknown; error: unknown }) {
  return {
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve(result) }) }) }),
  } as never
}
function mockUpdate(result: { error: unknown }) {
  return { from: () => ({ update: () => ({ eq: () => Promise.resolve(result) }) }) } as never
}
function mockAdvanceUpdate(result: { data: unknown; error: unknown }) {
  return {
    from: () => ({
      update: () => ({ eq: () => ({ eq: () => ({ select: () => Promise.resolve(result) }) }) }),
    }),
  } as never
}

const row = { client_id: 'c1', case_id: 'case1', lead_id: 'lead1' }

describe('createSequence', () => {
  it('should return the created sequence when the lead has none', async () => {
    const created = { id: 'seq1' }
    const result = await createSequence(mockUpsert({ data: [created], error: null }), row)
    expect(result).toEqual(created)
  })

  it('should return null when the lead already has a sequence', async () => {
    const result = await createSequence(mockUpsert({ data: [], error: null }), row)
    expect(result).toBeNull()
  })

  it('should throw DB_ERROR when the upsert errors', async () => {
    await expect(
      createSequence(mockUpsert({ data: null, error: { message: 'boom' } }), row),
    ).rejects.toBeInstanceOf(AppError)
  })
})

describe('getSequenceById', () => {
  it('should return the sequence when found', async () => {
    const seq = { id: 'seq1' }
    const result = await getSequenceById(mockGet({ data: seq, error: null }), 'seq1')
    expect(result).toEqual(seq)
  })

  it('should return null when not found', async () => {
    const result = await getSequenceById(mockGet({ data: null, error: null }), 'seq1')
    expect(result).toBeNull()
  })

  it('should throw DB_ERROR when the query errors', async () => {
    await expect(
      getSequenceById(mockGet({ data: null, error: { message: 'boom' } }), 'seq1'),
    ).rejects.toBeInstanceOf(AppError)
  })
})

describe('advanceSequence', () => {
  it('should resolve when the update claims an active row', async () => {
    await expect(
      advanceSequence(mockAdvanceUpdate({ data: [{ id: 'seq1' }], error: null }), 'seq1', {
        currentStep: 1, nextActionAt: null, qstashMessageId: null,
      }),
    ).resolves.toBeUndefined()
  })

  it('should throw DB_ERROR when the update errors', async () => {
    await expect(
      advanceSequence(mockAdvanceUpdate({ data: null, error: { message: 'boom' } }), 'seq1', {
        currentStep: 1, nextActionAt: null, qstashMessageId: null,
      }),
    ).rejects.toBeInstanceOf(AppError)
  })

  it('should throw DB_ERROR when the sequence is no longer active (stale claim)', async () => {
    await expect(
      advanceSequence(mockAdvanceUpdate({ data: [], error: null }), 'seq1', {
        currentStep: 1, nextActionAt: null, qstashMessageId: null,
      }),
    ).rejects.toBeInstanceOf(AppError)
  })
})

describe('stopSequence', () => {
  it('should resolve when the update succeeds', async () => {
    await expect(stopSequence(mockUpdate({ error: null }), 'seq1', 'stopped')).resolves.toBeUndefined()
  })

  it('should throw DB_ERROR when the update errors', async () => {
    await expect(
      stopSequence(mockUpdate({ error: { message: 'boom' } }), 'seq1', 'stopped'),
    ).rejects.toBeInstanceOf(AppError)
  })
})

describe('pauseActiveSequenceForLead', () => {
  it('should update only active sequences to paused', async () => {
    const update = vi.fn(() => ({ eq: () => ({ eq: () => Promise.resolve({ error: null }) }) }))
    const supabase = { from: () => ({ update }) } as never
    await pauseActiveSequenceForLead(supabase, 'lead1')
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ state: 'paused' }))
  })

  it('should throw DB_ERROR when the update errors', async () => {
    const supabase = {
      from: () => ({ update: () => ({ eq: () => ({ eq: () => Promise.resolve({ error: { message: 'boom' } }) }) }) }),
    } as never
    await expect(pauseActiveSequenceForLead(supabase, 'lead1')).rejects.toBeInstanceOf(AppError)
  })
})

describe('stopSequenceForLead', () => {
  it('should resolve when the update succeeds', async () => {
    const supabase = {
      from: () => ({ update: () => ({ eq: () => ({ in: () => Promise.resolve({ error: null }) }) }) }),
    } as never
    await expect(stopSequenceForLead(supabase, 'lead1', 'stopped')).resolves.toBeUndefined()
  })

  it('should throw a DB_ERROR when the update fails', async () => {
    const supabase = {
      from: () => ({ update: () => ({ eq: () => ({ in: () => Promise.resolve({ error: { message: 'boom' } }) }) }) }),
    } as never
    await expect(stopSequenceForLead(supabase, 'lead1', 'stopped')).rejects.toMatchObject({ code: 'DB_ERROR' })
  })
})

function mockMaybeSingle(result: { data: unknown; error: unknown }) {
  return {
    from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve(result) }) }) }) }),
  } as never
}

describe('isSequenceActiveForLead', () => {
  it('should return true when an active sequence row exists for the lead', async () => {
    const result = await isSequenceActiveForLead(mockMaybeSingle({ data: { id: 'seq1' }, error: null }), 'lead1')
    expect(result).toBe(true)
  })

  it('should return false when no active sequence row exists (paused, stopped, or replied)', async () => {
    const result = await isSequenceActiveForLead(mockMaybeSingle({ data: null, error: null }), 'lead1')
    expect(result).toBe(false)
  })

  it('should throw DB_ERROR when the query errors', async () => {
    await expect(
      isSequenceActiveForLead(mockMaybeSingle({ data: null, error: { message: 'boom' } }), 'lead1'),
    ).rejects.toBeInstanceOf(AppError)
  })
})

describe('requestFollowupSkip', () => {
  it('should set the flag only on the lead\'s active sequence', async () => {
    const stateEq = vi.fn().mockResolvedValue({ error: null })
    const leadEq = vi.fn().mockReturnValue({ eq: stateEq })
    const update = vi.fn().mockReturnValue({ eq: leadEq })
    const supabase = { from: () => ({ update }) } as never

    await requestFollowupSkip(supabase, 'lead1')

    expect(update).toHaveBeenCalledWith({ skip_next_step: true })
    expect(leadEq).toHaveBeenCalledWith('lead_id', 'lead1')
    expect(stateEq).toHaveBeenCalledWith('state', 'active')
  })

  it('should throw DB_ERROR when the update fails', async () => {
    const supabase = {
      from: () => ({
        update: () => ({ eq: () => ({ eq: () => Promise.resolve({ error: { message: 'boom' } }) }) }),
      }),
    } as never
    await expect(requestFollowupSkip(supabase, 'lead1')).rejects.toMatchObject({ code: 'DB_ERROR' })
  })
})

describe('consumeFollowupSkip', () => {
  it('should clear the flag and report the win', async () => {
    const select = vi.fn().mockResolvedValue({ data: [{ id: 'seq1' }], error: null })
    const flagEq = vi.fn().mockReturnValue({ select })
    const stateEq = vi.fn().mockReturnValue({ eq: flagEq })
    const idEq = vi.fn().mockReturnValue({ eq: stateEq })
    const update = vi.fn().mockReturnValue({ eq: idEq })
    const supabase = { from: () => ({ update }) } as never

    await expect(consumeFollowupSkip(supabase, 'seq1')).resolves.toBe(true)

    expect(update).toHaveBeenCalledWith({ skip_next_step: false })
    expect(idEq).toHaveBeenCalledWith('id', 'seq1')
    expect(stateEq).toHaveBeenCalledWith('state', 'active')
    expect(flagEq).toHaveBeenCalledWith('skip_next_step', true)
  })

  it('should report false when another delivery already consumed the flag', async () => {
    const supabase = {
      from: () => ({
        update: () => ({
          eq: () => ({ eq: () => ({ eq: () => ({ select: () => Promise.resolve({ data: [], error: null }) }) }) }),
        }),
      }),
    } as never
    await expect(consumeFollowupSkip(supabase, 'seq1')).resolves.toBe(false)
  })

  it('should throw DB_ERROR when the update fails', async () => {
    const supabase = {
      from: () => ({
        update: () => ({
          eq: () => ({
            eq: () => ({ eq: () => ({ select: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }) }),
          }),
        }),
      }),
    } as never
    await expect(consumeFollowupSkip(supabase, 'seq1')).rejects.toMatchObject({ code: 'DB_ERROR' })
  })
})
