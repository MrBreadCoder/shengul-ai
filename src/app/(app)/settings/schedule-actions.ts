'use server'

import { revalidatePath } from 'next/cache'
import { requireUser } from '@/lib/auth/require-user'
import { createAdminClient } from '@/lib/supabase/admin'
import { updateClientSchedule } from '@/lib/db/clients'
import { recomputeClientCampaignSchedules } from '@/lib/db/campaigns'
import { timeOfDaySchema, timezoneSchema } from '@/lib/validation/schedule'
import { logEvent } from '@/lib/events/log-event'
import { AppError } from '@/lib/errors/app-error'

const SETTINGS_PATH = '/settings'

// Client-owned preference, same shape as updateReplyMode/updateFollowupCadence.
// Recomputes next_discover_at for every campaign that inherits this default
// (recomputeClientCampaignSchedules) — a campaign with its own override is
// left untouched.
export async function updateSchedule(formData: FormData): Promise<void> {
  const { appUser } = await requireUser()
  if (appUser.role !== 'client' || appUser.client_id === null) {
    throw new AppError('FORBIDDEN', 'Only a client may change their discovery schedule', { role: appUser.role })
  }

  const timezoneParsed = timezoneSchema.safeParse(formData.get('timezone'))
  if (!timezoneParsed.success) {
    throw new AppError('VALIDATION_ERROR', 'Invalid timezone', { issues: timezoneParsed.error.flatten() })
  }
  const timeParsed = timeOfDaySchema.safeParse(formData.get('defaultDiscoverTime'))
  if (!timeParsed.success) {
    throw new AppError('VALIDATION_ERROR', 'Invalid default discovery time', { issues: timeParsed.error.flatten() })
  }

  const admin = createAdminClient()
  await updateClientSchedule(admin, appUser.client_id, {
    timezone: timezoneParsed.data,
    default_discover_time: timeParsed.data,
  })
  await recomputeClientCampaignSchedules(admin, appUser.client_id)
  await logEvent({
    clientId: appUser.client_id,
    actor: `human:${appUser.id}`,
    type: 'client.schedule_changed',
    payload: { timezone: timezoneParsed.data, defaultDiscoverTime: timeParsed.data },
  })
  revalidatePath(SETTINGS_PATH)
}
