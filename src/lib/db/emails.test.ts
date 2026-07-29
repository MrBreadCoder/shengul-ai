import { describe, it, expect, vi } from 'vitest'
import {
  claimOutboundEmail,
  insertManualEmail,
  claimDraftForSend,
  markEmailSent,
  markEmailFailed,
  listThreadEmails,
  hasInboundReply,
  hasReplyForInbound,
  listDraftEmailsForClient,
  getEmailById,
  insertInboundEmail,
  claimReplyEmail,
  markLatestOutboundBounced,
} from './emails'
import { AppError } from '@/lib/errors/app-error'

function mockClaimDraft(result: { data: unknown; error: unknown }) {
  return {
    from: () => ({
      update: () => ({ eq: () => ({ eq: () => ({ select: () => Promise.resolve(result) }) }) }),
    }),
  } as never
}

function mockClaim(result: { data: unknown; error: unknown }) {
  return { from: () => ({ upsert: () => ({ select: () => Promise.resolve(result) }) }) } as never
}

// claimOutboundEmail's slot-taken path falls through to a reclaim update
// (`.update().eq().eq().eq().eq().select()`) — this mock supplies both legs.
function mockClaimWithReclaim(
  claimResult: { data: unknown; error: unknown },
  reclaimResult: { data: unknown; error: unknown },
) {
  return {
    from: () => ({
      upsert: () => ({ select: () => Promise.resolve(claimResult) }),
      update: () => ({
        eq: () => ({ eq: () => ({ eq: () => ({ eq: () => ({ select: () => Promise.resolve(reclaimResult) }) }) }) }),
      }),
    }),
  } as never
}
function mockUpdate(result: { error: unknown }) {
  return { from: () => ({ update: () => ({ eq: () => Promise.resolve(result) }) }) } as never
}
function mockReply(result: { count: number | null; error: unknown }) {
  return {
    from: () => ({
      select: () => ({ eq: () => ({ eq: () => Promise.resolve(result) }) }),
    }),
  } as never
}
function mockCount(result: { count: number | null; error: unknown }) {
  return { from: () => ({ select: () => ({ eq: () => Promise.resolve(result) }) }) } as never
}
function mockList(result: { data: unknown; error: unknown }) {
  return {
    from: () => ({
      select: () => ({ eq: () => ({ order: () => Promise.resolve(result) }) }),
    }),
  } as never
}
function mockDraftList(result: { data: unknown; error: unknown }) {
  return {
    from: () => ({
      select: () => ({ eq: () => ({ eq: () => ({ order: () => Promise.resolve(result) }) }) }),
    }),
  } as never
}
function mockGetById(result: { data: unknown; error: unknown }) {
  return {
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve(result) }) }) }),
  } as never
}

const insert = {
  client_id: 'c1', case_id: 'case1', lead_id: 'lead1',
  direction: 'outbound' as const, subject: 's', body: 'b',
  status: 'queued' as const, sequence_step: 0,
}

describe('claimOutboundEmail', () => {
  it('should return the claimed row when the slot is free', async () => {
    const claimed = { id: 'e1' }
    const result = await claimOutboundEmail(mockClaim({ data: [claimed], error: null }), insert)
    expect(result).toEqual(claimed)
  })

  it('should return null when the slot is already claimed by a non-failed row', async () => {
    const result = await claimOutboundEmail(
      mockClaimWithReclaim({ data: [], error: null }, { data: [], error: null }),
      insert,
    )
    expect(result).toBeNull()
  })

  it('should reclaim the slot for retry when the existing row is status: failed', async () => {
    const reclaimed = { id: 'e1', status: 'queued' }
    const result = await claimOutboundEmail(
      mockClaimWithReclaim({ data: [], error: null }, { data: [reclaimed], error: null }),
      insert,
    )
    expect(result).toEqual(reclaimed)
  })

  it('should throw DB_ERROR when the upsert errors', async () => {
    await expect(
      claimOutboundEmail(mockClaim({ data: null, error: { message: 'boom' } }), insert),
    ).rejects.toBeInstanceOf(AppError)
  })

  it('should throw DB_ERROR when the reclaim update errors', async () => {
    await expect(
      claimOutboundEmail(
        mockClaimWithReclaim({ data: [], error: null }, { data: null, error: { message: 'boom' } }),
        insert,
      ),
    ).rejects.toBeInstanceOf(AppError)
  })
})

describe('insertInboundEmail', () => {
  it('should return the inserted row when the inbound message is new', async () => {
    const row = { id: 'in1' }
    const result = await insertInboundEmail(mockClaim({ data: [row], error: null }), {
      client_id: 'c1', direction: 'inbound', provider_message_id: 'g-abc', status: 'delivered',
    })
    expect(result).toEqual(row)
  })

  it('should return null when the provider message was already ingested', async () => {
    const result = await insertInboundEmail(mockClaim({ data: [], error: null }), {
      client_id: 'c1', direction: 'inbound', provider_message_id: 'g-abc', status: 'delivered',
    })
    expect(result).toBeNull()
  })

  it('should throw DB_ERROR when the upsert errors', async () => {
    await expect(
      insertInboundEmail(mockClaim({ data: null, error: { message: 'boom' } }), {
        client_id: 'c1', direction: 'inbound', provider_message_id: 'g-abc', status: 'delivered',
      }),
    ).rejects.toBeInstanceOf(AppError)
  })
})

describe('claimReplyEmail', () => {
  it('should return the claimed row when the reply slot is free', async () => {
    const row = { id: 'out1' }
    const result = await claimReplyEmail(mockClaim({ data: [row], error: null }), {
      client_id: 'c1', direction: 'outbound', in_reply_to_email_id: 'in1', status: 'queued',
    })
    expect(result).toEqual(row)
  })

  it('should return null when a reply already exists for the inbound email', async () => {
    const result = await claimReplyEmail(mockClaim({ data: [], error: null }), {
      client_id: 'c1', direction: 'outbound', in_reply_to_email_id: 'in1', status: 'queued',
    })
    expect(result).toBeNull()
  })

  it('should throw DB_ERROR when the upsert errors', async () => {
    await expect(
      claimReplyEmail(mockClaim({ data: null, error: { message: 'boom' } }), {
        client_id: 'c1', direction: 'outbound', in_reply_to_email_id: 'in1', status: 'queued',
      }),
    ).rejects.toBeInstanceOf(AppError)
  })
})

describe('claimDraftForSend', () => {
  it('should return the row when the draft is claimed', async () => {
    const row = { id: 'e1', status: 'queued' }
    const result = await claimDraftForSend(mockClaimDraft({ data: [row], error: null }), 'e1')
    expect(result).toEqual(row)
  })

  it('should return null when the row was already claimed by a concurrent caller', async () => {
    const result = await claimDraftForSend(mockClaimDraft({ data: [], error: null }), 'e1')
    expect(result).toBeNull()
  })

  it('should throw DB_ERROR when the update errors', async () => {
    await expect(
      claimDraftForSend(mockClaimDraft({ data: null, error: { message: 'boom' } }), 'e1'),
    ).rejects.toBeInstanceOf(AppError)
  })
})

describe('markEmailSent', () => {
  it('should resolve when the update succeeds', async () => {
    await expect(
      markEmailSent(mockUpdate({ error: null }), 'e1', {
        providerMessageId: 'p', threadId: 't', mailboxId: 'm',
      }),
    ).resolves.toBeUndefined()
  })

  it('should throw DB_ERROR when the update errors', async () => {
    await expect(
      markEmailSent(mockUpdate({ error: { message: 'boom' } }), 'e1', {
        providerMessageId: 'p', threadId: 't', mailboxId: 'm',
      }),
    ).rejects.toBeInstanceOf(AppError)
  })
})

describe('markEmailFailed', () => {
  it('should resolve when the update succeeds', async () => {
    await expect(markEmailFailed(mockUpdate({ error: null }), 'e1')).resolves.toBeUndefined()
  })

  it('should throw DB_ERROR when the update errors', async () => {
    await expect(
      markEmailFailed(mockUpdate({ error: { message: 'boom' } }), 'e1'),
    ).rejects.toBeInstanceOf(AppError)
  })
})

describe('listThreadEmails', () => {
  it('should return rows for the lead when the query succeeds', async () => {
    const rows = [{ id: 'e1' }]
    const result = await listThreadEmails(mockList({ data: rows, error: null }), 'lead1')
    expect(result).toEqual(rows)
  })

  it('should throw DB_ERROR when the query errors', async () => {
    await expect(
      listThreadEmails(mockList({ data: null, error: { message: 'boom' } }), 'lead1'),
    ).rejects.toBeInstanceOf(AppError)
  })
})

describe('hasInboundReply', () => {
  it('should return true when at least one inbound email exists', async () => {
    const result = await hasInboundReply(mockReply({ count: 1, error: null }), 'lead1')
    expect(result).toBe(true)
  })

  it('should return false when no inbound email exists', async () => {
    const result = await hasInboundReply(mockReply({ count: 0, error: null }), 'lead1')
    expect(result).toBe(false)
  })

  it('should throw DB_ERROR when the query errors', async () => {
    await expect(
      hasInboundReply(mockReply({ count: null, error: { message: 'boom' } }), 'lead1'),
    ).rejects.toBeInstanceOf(AppError)
  })
})

describe('hasReplyForInbound', () => {
  it('should return true when a reply already exists', async () => {
    const result = await hasReplyForInbound(mockCount({ count: 1, error: null }), 'in1')
    expect(result).toBe(true)
  })

  it('should return false when no reply exists', async () => {
    const result = await hasReplyForInbound(mockCount({ count: 0, error: null }), 'in1')
    expect(result).toBe(false)
  })

  it('should throw DB_ERROR when the query errors', async () => {
    await expect(
      hasReplyForInbound(mockCount({ count: null, error: { message: 'boom' } }), 'in1'),
    ).rejects.toBeInstanceOf(AppError)
  })
})

describe('listDraftEmailsForClient', () => {
  it('should return draft rows when the query succeeds', async () => {
    const rows = [{ id: 'e1', status: 'draft' }]
    expect(await listDraftEmailsForClient(mockDraftList({ data: rows, error: null }))).toEqual(rows)
  })

  it('should throw DB_ERROR when the query errors', async () => {
    await expect(
      listDraftEmailsForClient(mockDraftList({ data: null, error: { message: 'boom' } })),
    ).rejects.toBeInstanceOf(AppError)
  })
})

describe('getEmailById', () => {
  it('should return the email when found', async () => {
    const row = { id: 'e1', status: 'draft' }
    expect(await getEmailById(mockGetById({ data: row, error: null }), 'e1')).toEqual(row)
  })

  it('should return null when not found', async () => {
    expect(await getEmailById(mockGetById({ data: null, error: null }), 'e1')).toBeNull()
  })

  it('should throw DB_ERROR when the query errors', async () => {
    await expect(
      getEmailById(mockGetById({ data: null, error: { message: 'boom' } }), 'e1'),
    ).rejects.toBeInstanceOf(AppError)
  })
})

function mockBounceTarget(
  lookup: { data: unknown; error: unknown },
  update: { data: unknown; error: unknown },
) {
  const builder = {
    select: () => builder,
    eq: () => builder,
    in: () => builder,
    order: () => builder,
    limit: () => Promise.resolve(lookup),
  }
  const updateBuilder = {
    eq: () => updateBuilder,
    in: () => updateBuilder,
    select: () => Promise.resolve(update),
  }
  return { from: () => ({ select: builder.select, update: () => updateBuilder }) } as never
}

describe('markLatestOutboundBounced', () => {
  it('should flip the most recent sent outbound email to bounced', async () => {
    const result = await markLatestOutboundBounced(
      mockBounceTarget(
        { data: [{ id: 'e1', status: 'sent' }], error: null },
        { data: [{ id: 'e1', status: 'bounced' }], error: null },
      ),
      'l1',
    )
    expect(result).toEqual({ id: 'e1', status: 'bounced' })
  })

  it('should return null when the lead has no sent outbound email', async () => {
    const result = await markLatestOutboundBounced(mockBounceTarget({ data: [], error: null }, { data: [], error: null }), 'l1')
    expect(result).toBeNull()
  })

  it('should throw DB_ERROR when the lookup fails', async () => {
    await expect(
      markLatestOutboundBounced(mockBounceTarget({ data: null, error: { message: 'boom' } }, { data: [], error: null }), 'l1'),
    ).rejects.toBeInstanceOf(AppError)
  })
})

describe('insertManualEmail', () => {
  it('should insert the row and return it', async () => {
    const insert = vi.fn().mockReturnValue({
      select: () => ({ single: () => Promise.resolve({ data: { id: 'e9' }, error: null }) }),
    })
    const supabase = { from: () => ({ insert }) } as never

    const result = await insertManualEmail(supabase, {
      client_id: 'c1', case_id: 'case1', lead_id: 'lead1', direction: 'outbound',
      subject: 's', body: 'b', status: 'queued', sequence_step: null, sent_by: 'u1',
    })

    expect(result).toEqual({ id: 'e9' })
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ sequence_step: null, sent_by: 'u1' }))
  })

  it('should throw DB_ERROR when the insert fails', async () => {
    const supabase = {
      from: () => ({
        insert: () => ({ select: () => ({ single: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }) }),
      }),
    } as never
    await expect(
      insertManualEmail(supabase, {
        client_id: 'c1', direction: 'outbound', status: 'queued',
      }),
    ).rejects.toMatchObject({ code: 'DB_ERROR' })
  })
})
