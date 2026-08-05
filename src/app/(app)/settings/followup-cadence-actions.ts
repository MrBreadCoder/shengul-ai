'use server'

import { revalidatePath } from 'next/cache'
import { requireUser } from '@/lib/auth/require-user'
import { createAdminClient } from '@/lib/supabase/admin'
import { updateClientFollowupDelays } from '@/lib/db/clients'
import { followupDelaysSchema } from '@/lib/validation/followup-limits'
import { logEvent } from '@/lib/events/log-event'
import { AppError } from '@/lib/errors/app-error'

const SETTINGS_PATH = '/settings'

// Client-owned preference, same shape as updateReplyMode. Does NOT bulk-sync
// onto existing sequences — a client changing their default should not
// silently reschedule every in-flight contact; the per-lead override on the
// case page is the explicit tool for that.
export async function updateFollowupCadence(formData: FormData): Promise<void> {
  const { appUser } = await requireUser()
  if (appUser.role !== 'client' || appUser.client_id === null) {
    throw new AppError('FORBIDDEN', 'Only a client may change their follow-up cadence', { role: appUser.role })
  }

  const parsed = followupDelaysSchema.safeParse(formData.getAll('delaysDays'))
  if (!parsed.success) {
    throw new AppError('VALIDATION_ERROR', 'Invalid follow-up cadence', { issues: parsed.error.flatten() })
  }

  const admin = createAdminClient()
  await updateClientFollowupDelays(admin, appUser.client_id, parsed.data)
  await logEvent({
    clientId: appUser.client_id,
    actor: `human:${appUser.id}`,
    type: 'client.followup_cadence_changed',
    payload: { delaysDays: parsed.data },
  })
  revalidatePath(SETTINGS_PATH)
}
