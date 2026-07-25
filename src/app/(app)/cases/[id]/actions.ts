'use server'

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { requireUser } from '@/lib/auth/require-user'
import { createServerClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getLeadById, parkLead } from '@/lib/db/leads'
import { addSuppression } from '@/lib/db/suppressions'
import { stopSequenceForLead } from '@/lib/db/sequences'
import { logEventSafe } from '@/lib/events/log-event'
import { AppError } from '@/lib/errors/app-error'

const stopLeadSchema = z.object({
  leadId: z.string().uuid(),
  caseId: z.string().uuid(),
})

/**
 * Stops all outreach to one person: suppress the address, stop the sequence,
 * park the lead so it drops out of listActiveLeadsForCase.
 *
 * Unlike approveDraft this is available to client-role users, because deciding
 * "do not contact this person" is the client's call, not the operator's. The
 * authorization boundary is the RLS-scoped read below: a client-role session can
 * only resolve leads its own policies expose, and the client_id is re-checked
 * against the session afterwards. The writes then go through the admin client
 * because RLS makes client-role users read-only (migration 0002).
 */
export async function stopLead(formData: FormData): Promise<void> {
  const { appUser } = await requireUser()
  const { leadId, caseId } = stopLeadSchema.parse({
    leadId: formData.get('leadId'),
    caseId: formData.get('caseId'),
  })

  const scoped = await createServerClient()
  const lead = await getLeadById(scoped, leadId)
  if (!lead) {
    throw new AppError('NOT_FOUND', 'Lead not found', { leadId })
  }
  if (appUser.role !== 'operator' && appUser.client_id !== lead.client_id) {
    throw new AppError('UNAUTHORIZED', 'Lead belongs to another client', { leadId, userId: appUser.id })
  }

  const admin = createAdminClient()
  // A lead can reach this state with no address (Apollo never revealed one).
  // Parking it is still the right outcome; there is just nothing to suppress.
  if (lead.email) {
    await addSuppression(admin, { clientId: lead.client_id, email: lead.email, reason: 'manual' })
  }
  await stopSequenceForLead(admin, leadId, 'stopped')
  await parkLead(admin, leadId)

  await logEventSafe({
    clientId: lead.client_id,
    caseId: lead.case_id,
    actor: `human:${appUser.id}`,
    type: 'lead.stopped',
    payload: { leadId, email: lead.email },
  })

  revalidatePath(`/cases/${caseId}`)
}
