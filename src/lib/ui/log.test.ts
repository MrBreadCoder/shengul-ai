import { describe, it, expect } from 'vitest'
import { describeEvent, LOG_SEVERITY_META, LOG_SOURCE_META } from './log'
import { LOG_SEVERITIES, LOG_SOURCES } from '@/types/logs'

describe('describeEvent', () => {
  it('should report the lead tally when given a completed discovery run', () => {
    const result = describeEvent('pipeline.discover.completed', {
      campaignId: 'camp1',
      inserted: 14,
      verified: 9,
      candidatesSeen: 220,
    })

    expect(result).toBe('Discovery run finished — 14 leads found, 9 with a verified email.')
  })

  it('should report the dossier size when given a completed research run', () => {
    const result = describeEvent('pipeline.research.completed', { knowledgeCount: 7, agentsFailed: 1 })

    expect(result).toBe('Research finished — 7 dossier facts gathered, 1 agent failed.')
  })

  it('should report send and draft counts when given a completed write run', () => {
    const result = describeEvent('pipeline.write.completed', { sent: 3, drafted: 1, leadCount: 4 })

    expect(result).toBe('Outreach written for 4 leads — 3 sent, 1 left as a draft.')
  })

  it('should surface the error message when given an error payload with no builder', () => {
    const result = describeEvent('some.unmapped.failure', {
      errorCode: 'EXTERNAL_TIMEOUT',
      errorMessage: 'HTTP request failed',
    })

    expect(result).toBe('HTTP request failed')
  })

  it('should humanize the event type when it has no builder and the payload carries nothing useful', () => {
    const result = describeEvent('mailbox.disconnected', {})

    expect(result).toBe('Mailbox disconnected')
  })

  it('should not throw when the payload is not an object', () => {
    expect(describeEvent('pipeline.discover.completed', null)).toBe(
      'Discovery run finished — 0 leads found, 0 with a verified email.',
    )
  })

  it('should name the vendor and the domain when given a failed email verification', () => {
    const result = describeEvent('emailable.verify.failed', {
      campaignId: 'camp1',
      domain: 'acme.com',
      errorMessage: 'HTTP 402',
    })

    expect(result).toBe('Email verification failed for a lead at acme.com: HTTP 402.')
  })

  it('should report a company-knowledge write failure with the error message', () => {
    const result = describeEvent('pipeline.company_knowledge_failed', {
      leadId: 'lead1',
      errorCode: 'DB_ERROR',
      errorMessage: 'insert failed',
    })

    expect(result).toBe('Could not save Apollo company info for a case: insert failed.')
  })

  it('should surface the mail server\'s own reply text and which leg failed', () => {
    const result = describeEvent('mailbox.connect_failed', {
      provider: 'smtp',
      stage: 'smtp',
      serverResponse: '535 5.7.8 Error: authentication failed',
      errorCode: 'UNAUTHORIZED',
      errorMessage: 'Mailbox credentials were rejected',
    })

    expect(result).toBe(
      'Mailbox connect failed on the sending (SMTP) server: 535 5.7.8 Error: authentication failed.',
    )
  })

  it('should fall back to the generic error message when the server never replied', () => {
    const result = describeEvent('mailbox.connect_failed', {
      provider: 'smtp',
      stage: 'imap',
      serverResponse: null,
      errorCode: 'EXTERNAL_TIMEOUT',
      errorMessage: 'Mail operation exceeded its deadline',
    })

    expect(result).toBe(
      'Mailbox connect failed on the reading (IMAP) server: Mail operation exceeded its deadline.',
    )
  })

  it('should surface the raw db error on a genuine mailbox insert failure', () => {
    const result = describeEvent('mailbox.connect_error', {
      provider: 'smtp',
      stage: 'insert',
      mailboxId: null,
      dbError: 'duplicate key value violates unique constraint "mailboxes_client_id_email_address_key"',
      errorCode: 'DB_ERROR',
      errorMessage: 'Failed to insert mailbox',
    })

    expect(result).toBe(
      'Could not save the mailbox: duplicate key value violates unique constraint "mailboxes_client_id_email_address_key".',
    )
  })

  it('should call out a created-but-unfinished mailbox row distinctly', () => {
    const result = describeEvent('mailbox.connect_error', {
      provider: 'smtp',
      stage: 'post_insert',
      mailboxId: 'mb1',
      dbError: 'insert into "events" violates check constraint',
      errorMessage: 'Failed to insert event',
    })

    expect(result).toBe(
      'Mailbox row mb1 was created, but finishing the connection failed: insert into "events" violates check constraint.',
    )
  })

  it('should report a client-resolution failure distinctly', () => {
    const result = describeEvent('mailbox.connect_error', {
      provider: 'smtp',
      stage: 'resolve_client',
      mailboxId: null,
      dbError: null,
      errorCode: 'FORBIDDEN',
      errorMessage: 'Client user has no client_id assigned',
    })

    expect(result).toBe(
      'Could not determine which client to attach the mailbox to: Client user has no client_id assigned.',
    )
  })

  it('should warn on a discovery run that activated leads without verification', () => {
    const result = describeEvent('pipeline.discover.completed', {
      campaignId: 'camp1',
      inserted: 14,
      verified: 9,
      emailableFailedOpen: 3,
    })

    expect(result).toBe(
      'Discovery run finished — 14 leads found, 9 with a verified email. 3 activated without verification — the deliverability guard was unavailable.',
    )
  })
})

describe('log display metadata', () => {
  it('should provide a label and colour for every severity', () => {
    for (const severity of LOG_SEVERITIES) {
      expect(LOG_SEVERITY_META[severity].label.length).toBeGreaterThan(0)
      expect(LOG_SEVERITY_META[severity].color).toContain('var(--')
    }
  })

  it('should provide a label and colour for every source', () => {
    for (const source of LOG_SOURCES) {
      expect(LOG_SOURCE_META[source].label.length).toBeGreaterThan(0)
      expect(LOG_SOURCE_META[source].color).toContain('var(--')
    }
  })
})
