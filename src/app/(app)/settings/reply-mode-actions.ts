'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireUser } from '@/lib/auth/require-user'
import { createAdminClient } from '@/lib/supabase/admin'
import { updateClientReplyMode } from '@/lib/db/clients'
import { syncReplyModeForClient } from '@/lib/db/campaigns'
import { logEvent } from '@/lib/events/log-event'
import { AppError } from '@/lib/errors/app-error'

const SETTINGS_PATH = '/settings'

const replyModeSchema = z.enum(['auto_send', 'human_approve', 'hybrid'])

export async function updateReplyMode(formData: FormData): Promise<void> {
  const { appUser } = await requireUser()
  if (appUser.role !== 'client' || appUser.client_id === null) {
    throw new AppError('FORBIDDEN', 'Only a client may change their reply mode', { role: appUser.role })
  }

  const parsed = replyModeSchema.safeParse(formData.get('replyMode'))
  if (!parsed.success) {
    throw new AppError('VALIDATION_ERROR', 'Invalid reply mode', { issues: parsed.error.flatten() })
  }

  const admin = createAdminClient()
  // Both writes target the same terminal value, not a delta — if the sync
  // half fails, retrying the action re-applies the same mode idempotently.
  await updateClientReplyMode(admin, appUser.client_id, parsed.data)
  await syncReplyModeForClient(admin, appUser.client_id, parsed.data)
  await logEvent({
    clientId: appUser.client_id,
    actor: `human:${appUser.id}`,
    type: 'client.reply_mode_changed',
    payload: { replyMode: parsed.data },
  })
  revalidatePath(SETTINGS_PATH)
}
