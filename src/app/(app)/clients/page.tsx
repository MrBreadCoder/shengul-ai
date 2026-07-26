import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { Buildings, Warning } from '@phosphor-icons/react/dist/ssr'
import { requireUser } from '@/lib/auth/require-user'
import { createAdminClient } from '@/lib/supabase/admin'
import { listClientsFull, type ClientRow } from '@/lib/db/clients'
import { countRecentErrorsByClient } from '@/lib/db/events'
import type { ClientErrorCount } from '@/types/logs'
import type { ClientDirectoryEntry } from '@/types/webmcp-app'
import { formatRelative } from '@/lib/format'
import { CLIENT_STATUS } from '@/lib/ui/status'
import { StatusPill } from '@/components/status-dot'
import { CompanyMark } from '@/components/company-mark'
import { PageHeader, Section } from '@/components/page-header'
import { EmptyState } from '@/components/empty-state'
import { NewClientForm } from './new-client-form'
import { ClientsWebMcpTools } from './clients-webmcp-tools'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Clients' }

// The window the health chip summarises. Short on purpose: an operator scanning
// this list wants "is this broken right now", not a lifetime error total.
const HEALTH_WINDOW_HOURS = 24

/**
 * Narrows a row to the fields the `listClients` WebMCP tool answers with, and
 * renames the Postgres columns to the `camelCase` the tool's schema declares.
 */
function toWebMcpEntry({ id, name, status, domain, created_at }: ClientRow): ClientDirectoryEntry {
  return { id, name, status, domain, createdAt: created_at }
}

interface ClientHealthChipProps {
  counts: ClientErrorCount | undefined
}

/**
 * Renders nothing when a client is healthy — an all-green list of "0 errors"
 * chips would train the operator to stop reading the column.
 */
function ClientHealthChip({ counts }: ClientHealthChipProps): React.ReactElement | null {
  if (!counts) return null
  const { errorCount, warnCount } = counts
  if (errorCount === 0 && warnCount === 0) return null

  const isError = errorCount > 0
  const count = isError ? errorCount : warnCount
  const noun = isError ? 'error' : 'warning'
  const color = isError ? 'var(--status-lost)' : 'var(--status-hot-handoff)'

  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap"
      style={{ color, background: `color-mix(in oklch, ${color} 14%, transparent)` }}
    >
      <Warning size={11} weight="fill" aria-hidden />
      <span className="tnum">{count}</span>
      {count === 1 ? noun : `${noun}s`} in {HEALTH_WINDOW_HOURS}h
    </span>
  )
}

export default async function ClientsPage(): Promise<React.ReactElement> {
  const { appUser } = await requireUser()
  if (appUser.role !== 'operator') redirect('/crm')

  const admin = createAdminClient()
  const now = new Date()
  const since = new Date(now.getTime() - HEALTH_WINDOW_HOURS * 60 * 60 * 1000).toISOString()
  const [clients, errorCounts] = await Promise.all([
    listClientsFull(admin),
    countRecentErrorsByClient(admin, since),
  ])

  return (
    <div className="flex max-w-3xl flex-col gap-10">
      <ClientsWebMcpTools clients={clients.map(toWebMcpEntry)} />
      <PageHeader
        title="Clients"
        description="Every client the agent runs campaigns for. Open one to manage its campaigns, analytics, and logins."
      />

      <Section title="New client">
        <NewClientForm />
      </Section>

      <Section title="All clients" aside={clients.length > 0 ? `${clients.length} total` : undefined}>
        {clients.length === 0 ? (
          <EmptyState
            icon={Buildings}
            title="No clients yet"
            description="Create one above, then open it to set up a campaign and invite a login."
          />
        ) : (
          <ul className="flex flex-col gap-2">
            {clients.map((client, index) => (
              <li
                key={client.id}
                className="animate-rise"
                style={{ animationDelay: `${Math.min(index, 10) * 30}ms` }}
              >
                <Link
                  href={`/clients/${client.id}`}
                  className="border-hairline bg-surface hover:bg-accent/40 hover:border-hairline-strong flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border p-4 transition-colors duration-200"
                >
                  <CompanyMark name={client.name} domain={client.domain} logoUrl={client.logo_url} />
                  <p className="min-w-0 flex-1 truncate text-[13px] font-medium">{client.name}</p>
                  <StatusPill meta={CLIENT_STATUS[client.status]} />
                  <ClientHealthChip counts={errorCounts.get(client.id)} />
                  <span className="text-faint text-[11px]">Created {formatRelative(client.created_at, now)}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  )
}
