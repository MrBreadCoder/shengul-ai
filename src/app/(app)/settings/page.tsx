import { requireUser } from '@/lib/auth/require-user'
import { createAdminClient } from '@/lib/supabase/admin'
import { ConnectButtons } from './connect-buttons'
import { MailboxRow } from './mailbox-row'

export const dynamic = 'force-dynamic'

export default async function SettingsPage() {
  const { appUser } = await requireUser()
  const admin = createAdminClient()
  const { data: mailboxes } = await admin
    .from('mailboxes')
    .select('id, provider, email_address, display_name, health, created_at')
    .order('created_at', { ascending: false })

  return (
    <main style={{ maxWidth: 640, margin: '48px auto', fontFamily: 'system-ui' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1>Settings</h1>
        <form action="/api/auth/signout" method="post">
          <button type="submit">Sign out</button>
        </form>
      </header>
      <p>Signed in as {appUser.role}.</p>

      <section>
        <h2>Connect a mailbox</h2>
        <ConnectButtons />
      </section>

      <section>
        <h2>Connected mailboxes</h2>
        {(!mailboxes || mailboxes.length === 0) && <p>No mailboxes connected yet.</p>}
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {mailboxes?.map((m) => (
            <li key={m.id} style={{ border: '1px solid #ddd', borderRadius: 8, padding: 12, marginBottom: 8 }}>
              <MailboxRow
                id={m.id}
                provider={m.provider}
                emailAddress={m.email_address}
                displayName={m.display_name}
                health={m.health}
              />
            </li>
          ))}
        </ul>
      </section>
    </main>
  )
}
