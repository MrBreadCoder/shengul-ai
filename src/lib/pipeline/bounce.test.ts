import { describe, it, expect, vi, beforeEach } from 'vitest'
import { handleBounce } from './bounce'
import type { BounceReport } from '@/lib/mailbox/bounce'

const findContactedLeadByEmail = vi.fn()
const parkLead = vi.fn()
const markLatestOutboundBounced = vi.fn()
const addSuppression = vi.fn()
const stopSequenceForLead = vi.fn()
const logEventSafe = vi.fn()
const logWarn = vi.fn()

vi.mock('@/lib/db/leads', () => ({
  findContactedLeadByEmail: (...args: unknown[]) => findContactedLeadByEmail(...args),
  parkLead: (...args: unknown[]) => parkLead(...args),
}))
vi.mock('@/lib/db/emails', () => ({
  markLatestOutboundBounced: (...args: unknown[]) => markLatestOutboundBounced(...args),
}))
vi.mock('@/lib/db/suppressions', () => ({
  addSuppression: (...args: unknown[]) => addSuppression(...args),
}))
vi.mock('@/lib/db/sequences', () => ({
  stopSequenceForLead: (...args: unknown[]) => stopSequenceForLead(...args),
}))
vi.mock('@/lib/events/log-event', () => ({
  logEventSafe: (...args: unknown[]) => logEventSafe(...args),
  logWarn: (...args: unknown[]) => logWarn(...args),
}))

const mailbox = { id: 'm1', client_id: 'c1', email_address: 'ops@acme.com' } as never
const supabase = {} as never

function report(overrides: Partial<BounceReport> = {}): BounceReport {
  return { kind: 'hard', recipient: 'vp@target.com', statusCode: '5.1.1', diagnostic: null, ...overrides }
}

beforeEach(() => {
  vi.clearAllMocks()
  findContactedLeadByEmail.mockResolvedValue({ id: 'l1', case_id: 'case1', email: 'vp@target.com' })
  markLatestOutboundBounced.mockResolvedValue({ id: 'e1' })
})

describe('handleBounce', () => {
  it('should suppress, stop and park the lead on a hard bounce', async () => {
    const outcome = await handleBounce(supabase, { mailbox, report: report() })
    expect(outcome).toBe('suppressed')
    expect(markLatestOutboundBounced).toHaveBeenCalledWith(supabase, 'l1')
    expect(addSuppression).toHaveBeenCalledWith(supabase, { clientId: 'c1', email: 'vp@target.com', reason: 'bounced' })
    expect(stopSequenceForLead).toHaveBeenCalledWith(supabase, 'l1', 'stopped')
    expect(parkLead).toHaveBeenCalledWith(supabase, 'l1')
  })

  it('should record a soft bounce without suppressing or marking the email', async () => {
    const outcome = await handleBounce(supabase, { mailbox, report: report({ kind: 'soft', statusCode: '4.2.2' }) })
    expect(outcome).toBe('recorded')
    expect(addSuppression).not.toHaveBeenCalled()
    expect(stopSequenceForLead).not.toHaveBeenCalled()
    expect(parkLead).not.toHaveBeenCalled()
    expect(markLatestOutboundBounced).not.toHaveBeenCalled()
  })

  it('should report unmatched when no recipient could be extracted', async () => {
    const outcome = await handleBounce(supabase, { mailbox, report: report({ recipient: null }) })
    expect(outcome).toBe('unmatched')
    expect(logWarn).toHaveBeenCalled()
    expect(findContactedLeadByEmail).not.toHaveBeenCalled()
  })

  it('should report unmatched when the recipient is not a lead we contacted', async () => {
    findContactedLeadByEmail.mockResolvedValue(null)
    const outcome = await handleBounce(supabase, { mailbox, report: report() })
    expect(outcome).toBe('unmatched')
    expect(addSuppression).not.toHaveBeenCalled()
  })

  it('should look the recipient up in lowercase', async () => {
    await handleBounce(supabase, { mailbox, report: report({ recipient: 'VP@Target.com' }) })
    expect(findContactedLeadByEmail).toHaveBeenCalledWith(supabase, 'c1', 'vp@target.com', 'm1')
  })
})
