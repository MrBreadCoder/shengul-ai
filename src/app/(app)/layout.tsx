import type { ReactNode } from 'react'
import { requireUser } from '@/lib/auth/require-user'
import { createServerClient } from '@/lib/supabase/server'
import { listDraftEmailsForClient } from '@/lib/db/emails'
import { listOpenKnowledgeRequestsForClient } from '@/lib/db/knowledge-requests'
import { getClientById } from '@/lib/db/clients'
import { AppShell, type SidebarBrand } from '@/components/shell/app-shell'

export const dynamic = 'force-dynamic'

export default async function AuthedLayout({
  children,
}: {
  children: ReactNode
}): Promise<React.ReactElement> {
  const { user, appUser } = await requireUser()
  const supabase = await createServerClient()

  // The nav badge is the single "how much is waiting on a human" number, so it
  // counts both things the inbox surfaces. RLS scopes both lists to the viewer.
  const [drafts, knowledgeRequests] = await Promise.all([
    listDraftEmailsForClient(supabase),
    listOpenKnowledgeRequestsForClient(supabase),
  ])

  // Operators aren't scoped to one client, so they always see the default
  // Beacon mark. `clients_select` RLS already permits a client-role user to
  // read their own row, so this reuses the viewer-scoped client rather than
  // the admin client. A missing row (should never happen while client_id is
  // set) just falls back to Beacon instead of failing the whole layout.
  let brand: SidebarBrand | null = null
  if (appUser.role === 'client' && appUser.client_id) {
    const client = await getClientById(supabase, appUser.client_id)
    if (client) brand = { name: client.name, domain: client.domain, logoUrl: client.logo_url }
  }

  return (
    <AppShell
      role={appUser.role}
      email={user.email ?? 'Signed in'}
      inboxCount={drafts.length + knowledgeRequests.length}
      brand={brand}
    >
      {children}
    </AppShell>
  )
}
