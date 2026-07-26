import { z } from 'zod'
import type {
  CampaignDirectoryEntry,
  ClientDirectoryEntry,
  MailboxHealthEntry,
} from '@/types/webmcp-app'
import type { WebMcpTool } from '@/types/webmcp'
import { defineWebMcpTool } from './define-tool'
import { jsonResult } from './result'

/**
 * Read-only tools for the authenticated console.
 *
 * Every one of these answers from data the page has already fetched and
 * rendered, so an agent gains no read it could not have got by scraping the
 * DOM — it just gets it typed. Nothing here mutates: creating a client, setting
 * up a campaign or answering a blocked question stays behind an annotated form
 * where the operator presses submit, because a WebMCP tool runs with the full
 * signed-in session.
 */

const clientStatusSchema = z.enum(['active', 'paused', 'archived'])
const campaignStatusSchema = z.enum(['active', 'paused', 'archived'])
const mailboxHealthSchema = z.enum(['ok', 'warning', 'blocked'])

const listClientsSchema = z.object({
  status: clientStatusSchema.optional().describe('Return only clients in this state. Omit for all of them.'),
})

const listCampaignsSchema = z.object({
  status: campaignStatusSchema
    .optional()
    .describe('Return only campaigns in this state. Omit for all of them.'),
  clientId: z
    .uuid('clientId must be a client id as returned by listClients.')
    .optional()
    .describe('Return only campaigns belonging to this client, using an id from listClients.'),
})

const mailboxHealthToolSchema = z.object({
  health: mailboxHealthSchema
    .optional()
    .describe("Return only mailboxes in this state. Omit for all of them. Use 'blocked' to find what is broken."),
})

export function buildClientDirectoryTool(clients: readonly ClientDirectoryEntry[]): WebMcpTool {
  return defineWebMcpTool({
    name: 'listClients',
    title: 'List clients',
    description:
      'The clients this console runs outreach for, with each one\'s state and website. Read-only: use the "New client" form on the page to add one.',
    inputSchema: listClientsSchema,
    isReadOnly: true,
    execute: ({ status }) => {
      const matches = status === undefined ? clients : clients.filter((entry) => entry.status === status)
      return { total: clients.length, returned: matches.length, clients: matches }
    },
    toResult: jsonResult,
  })
}

export function buildCampaignDirectoryTool(campaigns: readonly CampaignDirectoryEntry[]): WebMcpTool {
  return defineWebMcpTool({
    name: 'listCampaigns',
    title: 'List campaigns',
    description:
      'The outreach campaigns on this page — who each one targets, its daily discovery quota, how many mailboxes it sends from, and whether it is running. Read-only: use the "New campaign" form on the page to add one.',
    inputSchema: listCampaignsSchema,
    isReadOnly: true,
    execute: ({ status, clientId }) => {
      const matches = campaigns.filter(
        (entry) =>
          (status === undefined || entry.status === status) &&
          (clientId === undefined || entry.clientId === clientId),
      )
      return { total: campaigns.length, returned: matches.length, campaigns: matches }
    },
    toResult: jsonResult,
  })
}

export function buildMailboxHealthTool(mailboxes: readonly MailboxHealthEntry[]): WebMcpTool {
  return defineWebMcpTool({
    name: 'getMailboxHealth',
    title: 'Get mailbox health',
    description:
      'The mailboxes the agent sends from: provider, health, why a mailbox is unhealthy, and how much of today\'s send cap is used. The pipeline cannot send at all while every mailbox is blocked. Read-only: pausing or resuming a mailbox is done from the controls on the page.',
    inputSchema: mailboxHealthToolSchema,
    isReadOnly: true,
    execute: ({ health }) => {
      const matches = health === undefined ? mailboxes : mailboxes.filter((entry) => entry.health === health)
      const remainingToday = mailboxes.reduce(
        (total, { dailyCap, sentToday }) => total + Math.max(dailyCap - sentToday, 0),
        0,
      )
      return {
        total: mailboxes.length,
        returned: matches.length,
        // Zero means nothing more goes out today, whatever the health says.
        remainingSendsToday: remainingToday,
        mailboxes: matches,
      }
    },
    toResult: jsonResult,
  })
}
