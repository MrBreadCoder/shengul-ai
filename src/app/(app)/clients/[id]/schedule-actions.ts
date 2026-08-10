'use server'

import { revalidatePath } from 'next/cache'
import { requireUser } from '@/lib/auth/require-user'
import { createAdminClient } from '@/lib/supabase/admin'
import { getClientById, updateClientSchedule as updateClientScheduleRow } from '@/lib/db/clients'
import { recomputeClientCampaignSchedules } from '@/lib/db/campaigns'
import { timeOfDaySchema, timezoneSchema } from '@/lib/validation/schedule'
import { logEvent } from '@/lib/events/log-event'
import { AppError, isAppError, type AppErrorCode } from '@/lib/errors/app-error'

export type UpdateClientScheduleResult = { ok: true } | { ok: false; code: AppErrorCode; message: string }

// Operator-owned: what time and timezone this client's campaigns run their
// default discovery search at. Moved off the client-facing /settings page —
// see ScheduleSettings, the sibling component that calls this. Recomputes
// next_discover_at for every campaign that inherits this default; a campaign
// with its own override is left untouched.
export async function updateClientSchedule(
  clientId: string,
  timezone: string,
  defaultDiscoverTime: string,
): Promise<UpdateClientScheduleResult> {
  try {
    await updateClientScheduleUnsafe(clientId, timezone, defaultDiscoverTime)
    return { ok: true }
  } catch (error) {
    if (isAppError(error)) return { ok: false, code: error.code, message: error.message }
    throw error
  }
}

async function updateClientScheduleUnsafe(
  clientId: string,
  timezone: string,
  defaultDiscoverTime: string,
): Promise<void> {
  const { appUser } = await requireUser()
  if (appUser.role !== 'operator') {
    throw new AppError('UNAUTHORIZED', "Only an operator can change a client's discovery schedule", {
      clientId,
      userId: appUser.id,
    })
  }

  const timezoneParsed = timezoneSchema.safeParse(timezone)
  if (!timezoneParsed.success) {
    throw new AppError('VALIDATION_ERROR', 'Invalid timezone', { issues: timezoneParsed.error.flatten() })
  }
  const timeParsed = timeOfDaySchema.safeParse(defaultDiscoverTime)
  if (!timeParsed.success) {
    throw new AppError('VALIDATION_ERROR', 'Invalid default discovery time', { issues: timeParsed.error.flatten() })
  }

  const admin = createAdminClient()
  const client = await getClientById(admin, clientId)
  if (!client) throw new AppError('NOT_FOUND', 'Client not found', { clientId })

  await updateClientScheduleRow(admin, clientId, {
    timezone: timezoneParsed.data,
    default_discover_time: timeParsed.data,
  })
  await recomputeClientCampaignSchedules(admin, clientId)
  await logEvent({
    clientId,
    actor: `human:${appUser.id}`,
    type: 'client.schedule_changed',
    payload: { timezone: timezoneParsed.data, defaultDiscoverTime: timeParsed.data },
  })
  revalidatePath(`/clients/${clientId}`)
}
