'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireUser } from '@/lib/auth/require-user'
import { createAdminClient } from '@/lib/supabase/admin'
import {
  deleteCrmConnection, getCrmConnectionForClient, updateCrmConnectionPipeline,
} from '@/lib/db/crm-connections'
import { logEvent } from '@/lib/events/log-event'
import { AppError } from '@/lib/errors/app-error'

const SETTINGS_PATH = '/settings'

const selectionSchema = z.object({
  pipelineId: z.string().min(1),
  pipelineLabel: z.string().min(1),
  initialStageId: z.string().min(1),
  // Absent whenever the provider does not model closure as a stage (Pipedrive).
  wonStageId: z.string().min(1).nullable().default(null),
  lostStageId: z.string().min(1).nullable().default(null),
})

export async function selectCrmPipeline(formData: FormData): Promise<void> {
  const { appUser } = await requireUser()
  if (appUser.role !== 'client' || appUser.client_id === null) {
    throw new AppError('FORBIDDEN', 'Only a client may manage their CRM connection', { role: appUser.role })
  }

  const admin = createAdminClient()
  const connection = await getCrmConnectionForClient(admin, appUser.client_id)
  if (!connection) {
    throw new AppError('NOT_FOUND', 'No CRM connection to configure', { clientId: appUser.client_id })
  }

  const parsed = selectionSchema.safeParse({
    pipelineId: formData.get('pipelineId'),
    pipelineLabel: formData.get('pipelineLabel'),
    initialStageId: formData.get('initialStageId'),
    // Hidden inputs submit '' when the provider reported no closed stage —
    // normalize that to null so .nullable() (not .min(1)) is what applies.
    wonStageId: formData.get('wonStageId') || null,
    lostStageId: formData.get('lostStageId') || null,
  })
  if (!parsed.success) {
    throw new AppError('VALIDATION_ERROR', 'Pipeline selection is incomplete', {
      issues: parsed.error.flatten(),
    })
  }

  await updateCrmConnectionPipeline(admin, connection.id, parsed.data)
  await logEvent({
    clientId: appUser.client_id,
    actor: `human:${appUser.id}`,
    type: 'crm.pipeline_selected',
    source: 'crm',
    payload: { connectionId: connection.id, pipelineId: parsed.data.pipelineId },
  })
  revalidatePath(SETTINGS_PATH)
}

export async function disconnectCrm(): Promise<void> {
  const { appUser } = await requireUser()
  if (appUser.role !== 'client' || appUser.client_id === null) {
    throw new AppError('FORBIDDEN', 'Only a client may manage their CRM connection', { role: appUser.role })
  }

  const admin = createAdminClient()
  const connection = await getCrmConnectionForClient(admin, appUser.client_id)
  // Already disconnected — nothing to do, and surfacing an error here would
  // just confuse someone who double-submitted.
  if (!connection) return

  await deleteCrmConnection(admin, connection.id)
  await logEvent({
    clientId: appUser.client_id,
    actor: `human:${appUser.id}`,
    type: 'crm.disconnected',
    source: 'crm',
    payload: { connectionId: connection.id, provider: connection.provider },
  })
  revalidatePath(SETTINGS_PATH)
}
