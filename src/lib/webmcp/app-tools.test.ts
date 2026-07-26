import { describe, expect, it } from 'vitest'
import {
  buildCampaignDirectoryTool,
  buildClientDirectoryTool,
  buildMailboxHealthTool,
} from '@/lib/webmcp/app-tools'
import type {
  CampaignDirectoryEntry,
  ClientDirectoryEntry,
  MailboxHealthEntry,
} from '@/types/webmcp-app'
import type { WebMcpTool } from '@/types/webmcp'

const CLIENT_A_ID = '11111111-1111-4111-8111-111111111111'
const CLIENT_B_ID = '22222222-2222-4222-8222-222222222222'

const CLIENTS: readonly ClientDirectoryEntry[] = [
  { id: CLIENT_A_ID, name: 'Acme', status: 'active', domain: 'acme.com', createdAt: '2026-07-01T00:00:00.000Z' },
  { id: CLIENT_B_ID, name: 'Globex', status: 'paused', domain: null, createdAt: '2026-07-02T00:00:00.000Z' },
]

const CAMPAIGNS: readonly CampaignDirectoryEntry[] = [
  {
    id: 'c1',
    clientId: CLIENT_A_ID,
    name: 'Q3 ops',
    status: 'active',
    valueProp: 'We cut reconciliation time.',
    dailyTarget: 50,
    mailboxCount: 2,
    createdAt: '2026-07-03T00:00:00.000Z',
  },
  {
    id: 'c2',
    clientId: CLIENT_B_ID,
    name: 'Q3 finance',
    status: 'paused',
    valueProp: 'We shorten month-end close.',
    dailyTarget: 25,
    mailboxCount: 1,
    createdAt: '2026-07-04T00:00:00.000Z',
  },
]

const HEALTHY_MAILBOX: MailboxHealthEntry = {
  id: 'm1',
  provider: 'gmail',
  emailAddress: 'ops@acme.com',
  displayName: 'Acme Ops',
  health: 'ok',
  healthReason: null,
  dailyCap: 40,
  sentToday: 12,
  warmupProfile: 'standard',
  warmupStartedAt: '2026-07-01T00:00:00.000Z',
}

const BLOCKED_MAILBOX: MailboxHealthEntry = {
  id: 'm2',
  provider: 'smtp',
  emailAddress: 'hello@globex.com',
  displayName: null,
  health: 'blocked',
  healthReason: 'auth_failed',
  dailyCap: 30,
  sentToday: 30,
  warmupProfile: 'none',
  warmupStartedAt: null,
}

const MAILBOXES: readonly MailboxHealthEntry[] = [HEALTHY_MAILBOX, BLOCKED_MAILBOX]

/** Every tool returns JSON in one text part; this unwraps it for assertions. */
async function callTool(tool: WebMcpTool, input: unknown): Promise<Record<string, unknown>> {
  const result = await tool.execute(input)
  expect(result.isError, String(result.content[0]?.text)).toBeUndefined()
  return JSON.parse(String(result.content[0]?.text)) as Record<string, unknown>
}

describe('buildClientDirectoryTool', () => {
  it('should register as a read-only tool named listClients', () => {
    const tool = buildClientDirectoryTool(CLIENTS)
    expect(tool.name).toBe('listClients')
    expect(tool.annotations.readOnlyHint).toBe(true)
  })

  it('should return every client when no status filter is given', async () => {
    const output = await callTool(buildClientDirectoryTool(CLIENTS), {})
    expect(output).toMatchObject({ total: 2, returned: 2 })
    expect(output.clients).toEqual(CLIENTS)
  })

  it('should return only the clients in the requested status', async () => {
    const output = await callTool(buildClientDirectoryTool(CLIENTS), { status: 'paused' })
    expect(output).toMatchObject({ total: 2, returned: 1 })
    expect(output.clients).toEqual([CLIENTS[1]])
  })

  it('should reject a status outside the schema rather than silently returning everything', async () => {
    const result = await buildClientDirectoryTool(CLIENTS).execute({ status: 'deleted' })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('status')
  })

  it('should report zero returned without failing when nothing matches', async () => {
    const output = await callTool(buildClientDirectoryTool(CLIENTS), { status: 'archived' })
    expect(output).toMatchObject({ total: 2, returned: 0, clients: [] })
  })

  it('should handle a console with no clients at all', async () => {
    const output = await callTool(buildClientDirectoryTool([]), {})
    expect(output).toMatchObject({ total: 0, returned: 0, clients: [] })
  })
})

describe('buildCampaignDirectoryTool', () => {
  it('should register as a read-only tool named listCampaigns', () => {
    const tool = buildCampaignDirectoryTool(CAMPAIGNS)
    expect(tool.name).toBe('listCampaigns')
    expect(tool.annotations.readOnlyHint).toBe(true)
  })

  it('should return every campaign when no filter is given', async () => {
    const output = await callTool(buildCampaignDirectoryTool(CAMPAIGNS), {})
    expect(output).toMatchObject({ total: 2, returned: 2 })
  })

  it('should filter by client id', async () => {
    const output = await callTool(buildCampaignDirectoryTool(CAMPAIGNS), { clientId: CLIENT_B_ID })
    expect(output.campaigns).toEqual([CAMPAIGNS[1]])
  })

  it('should apply status and client id together', async () => {
    const output = await callTool(buildCampaignDirectoryTool(CAMPAIGNS), {
      status: 'active',
      clientId: CLIENT_B_ID,
    })
    expect(output).toMatchObject({ returned: 0, campaigns: [] })
  })

  it('should reject a clientId that is not an id, so a name is never matched by accident', async () => {
    const result = await buildCampaignDirectoryTool(CAMPAIGNS).execute({ clientId: 'Globex' })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('listClients')
  })

  it('should expose the mailbox count but never the mailbox ids', async () => {
    const output = await callTool(buildCampaignDirectoryTool(CAMPAIGNS), {})
    expect(JSON.stringify(output)).toContain('"mailboxCount":2')
    expect(JSON.stringify(output)).not.toContain('mailbox_ids')
  })
})

describe('buildMailboxHealthTool', () => {
  it('should register as a read-only tool named getMailboxHealth', () => {
    const tool = buildMailboxHealthTool(MAILBOXES)
    expect(tool.name).toBe('getMailboxHealth')
    expect(tool.annotations.readOnlyHint).toBe(true)
  })

  it('should return every mailbox with the remaining send headroom across all of them', async () => {
    const output = await callTool(buildMailboxHealthTool(MAILBOXES), {})
    // 40 - 12 on the healthy box, 0 on the exhausted one.
    expect(output).toMatchObject({ total: 2, returned: 2, remainingSendsToday: 28 })
  })

  it('should filter to the blocked mailboxes and surface the reason', async () => {
    const output = await callTool(buildMailboxHealthTool(MAILBOXES), { health: 'blocked' })
    expect(output).toMatchObject({ returned: 1 })
    expect(output.mailboxes).toEqual([BLOCKED_MAILBOX])
  })

  it('should report the full headroom regardless of the health filter applied', async () => {
    const output = await callTool(buildMailboxHealthTool(MAILBOXES), { health: 'blocked' })
    expect(output.remainingSendsToday).toBe(28)
  })

  it('should never report negative headroom when a mailbox has overshot its cap', async () => {
    const overshot: MailboxHealthEntry = { ...HEALTHY_MAILBOX, dailyCap: 10, sentToday: 25 }
    const output = await callTool(buildMailboxHealthTool([overshot]), {})
    expect(output.remainingSendsToday).toBe(0)
  })

  it('should report zero headroom when no mailbox is connected', async () => {
    const output = await callTool(buildMailboxHealthTool([]), {})
    expect(output).toMatchObject({ total: 0, returned: 0, remainingSendsToday: 0, mailboxes: [] })
  })

  it('should reject an unknown health value', async () => {
    const result = await buildMailboxHealthTool(MAILBOXES).execute({ health: 'degraded' })
    expect(result.isError).toBe(true)
  })
})
