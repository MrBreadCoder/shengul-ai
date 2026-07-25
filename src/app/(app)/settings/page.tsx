import type { Metadata } from 'next'
import { Envelope } from '@phosphor-icons/react/dist/ssr'
import { requireUser } from '@/lib/auth/require-user'
import { createServerClient } from '@/lib/supabase/server'
import { listMailboxesForViewer } from '@/lib/db/mailboxes'
import { PageHeader, Section } from '@/components/page-header'
import { EmptyState } from '@/components/empty-state'
import { ConnectButtons } from './connect-buttons'
import { MailboxRow } from './mailbox-row'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Settings' }

export default async function SettingsPage(): Promise<React.ReactElement> {
  const { appUser } = await requireUser()
  // RLS-scoped on purpose. The admin client would bypass `mailboxes_select` and
  // show a client-role user every other client's connected addresses.
  const supabase = await createServerClient()
  const connected = await listMailboxesForViewer(supabase)

  return (
    <div className="flex max-w-3xl flex-col gap-10">
      <PageHeader
        title="Settings"
        description={`Signed in as ${appUser.role}. Mailboxes connected here are what the agent sends from.`}
      />

      <Section title="Connect a mailbox">
        <ConnectButtons />
      </Section>

      <Section
        title="Connected mailboxes"
        aside={connected.length > 0 ? `${connected.length} connected` : undefined}
      >
        {connected.length === 0 ? (
          <EmptyState
            icon={Envelope}
            title="No mailboxes connected"
            description="The agent cannot send until at least one mailbox is connected and assigned to a campaign."
          />
        ) : (
          <ul className="flex flex-col gap-2">
            {connected.map((mailbox) => (
              <li key={mailbox.id}>
                <MailboxRow
                  id={mailbox.id}
                  provider={mailbox.provider}
                  emailAddress={mailbox.email_address}
                  displayName={mailbox.display_name}
                  health={mailbox.health}
                  healthReason={mailbox.health_reason}
                  warmupProfile={mailbox.warmup_profile}
                  warmupStartedAt={mailbox.warmup_started_at}
                  dailyCap={mailbox.daily_cap}
                  sentToday={mailbox.sent_today}
                  viewerRole={appUser.role}
                />
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  )
}
